import AVFoundation
import Foundation

struct AudioInputDevice: Equatable, Identifiable {
    let id: String
    let name: String

    static func available() throws -> [AudioInputDevice] {
        let devices = discoveredDevices()
        guard !devices.isEmpty else { throw AudioRecorderError.devicesUnavailable }
        let defaultID = AVCaptureDevice.default(for: .audio)?.uniqueID
        return devices.map { device in
            let displayName = device.uniqueID == defaultID ? "\(device.localizedName)（系统默认）" : device.localizedName
            return AudioInputDevice(id: device.uniqueID, name: displayName)
        }.sorted { lhs, rhs in
            if lhs.id == defaultID { return true }
            if rhs.id == defaultID { return false }
            return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
        }
    }

    static func discoveredDevices() -> [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInMicrophone, .externalUnknown], mediaType: .audio,
                                         position: .unspecified).devices
    }
}

struct AudioCaptureSummary {
    let sampleBuffers: Int
    let decodedBuffers: Int
    let writtenBuffers: Int
    let firstFailure: String?
    let sessionErrorCode: Int?

    var resultDescription: String {
        if sampleBuffers == 0 { return "no-sample-buffers" }
        if decodedBuffers == 0 { return "sample-decode-failed" }
        if writtenBuffers == 0 { return "pcm-write-failed" }
        return "audio-received"
    }
}

@MainActor
final class VoiceInputRecorder {
    private var captureSession: AVCaptureSession?
    private var captureOutput: AVCaptureAudioDataOutput?
    private var captureDelegate: AudioCaptureDelegate?
    private var sessionErrorObserver: NSObjectProtocol?
    private var pipeline: AudioCapturePipeline?
    private var statistics: AudioCaptureStatistics?
    private let sampleQueue = DispatchQueue(label: "local.desktop-pets.microphone-samples",
                                            qos: .userInitiated)
    private var limitTimer: Timer?
    private let requestAccess: (@escaping (Bool) -> Void) -> Void
    private var pendingPermission: (id: UUID, completion: (Result<Void, Error>) -> Void)?
    private var lastCaptureSummary = AudioCaptureSummary.empty
    var onLimitReached: ((URL?) -> Void)?
    var onInputLevel: ((Float) -> Void)?
    var onDiagnostic: ((String) -> Void)?

    var isRecording: Bool { captureSession?.isRunning == true }
    private(set) var peakLevel: Float = 0
    var captureSummary: AudioCaptureSummary { statistics?.snapshot ?? lastCaptureSummary }

    init(requestAccess: @escaping (@escaping (Bool) -> Void) -> Void = {
        AVCaptureDevice.requestAccess(for: .audio, completionHandler: $0)
    }) {
        self.requestAccess = requestAccess
    }

    func start(deviceUID: String?, duration: TimeInterval = 20,
               completion: @escaping (Result<Void, Error>) -> Void) {
        guard pendingPermission == nil, !isRecording else {
            completion(.failure(AudioRecorderError.couldNotStart)); return
        }
        let requestID = UUID()
        pendingPermission = (requestID, completion)
        requestAccess { [weak self] granted in
            Task { @MainActor in
                guard let self, let pending = self.pendingPermission, pending.id == requestID else { return }
                self.pendingPermission = nil
                let completion = pending.completion
                guard granted else {
                    completion(.failure(AudioRecorderError.permissionDenied))
                    return
                }
                do {
                    try self.startEngine(deviceUID: deviceUID, duration: duration)
                    completion(.success(()))
                } catch {
                    self.stopCapture(deleteFile: true)
                    completion(.failure(error))
                }
            }
        }
    }

    func stop() -> URL? {
        stopCapture(deleteFile: false)
    }

    func cancel() {
        _ = stopCapture(deleteFile: true)
    }

    private func startEngine(deviceUID: String?, duration: TimeInterval) throws {
        let devices = try AudioInputDevice.available()
        guard !devices.isEmpty else { throw AudioRecorderError.noInputDevice }
        let selectedUID = deviceUID.flatMap { uid in devices.first { $0.id == uid }?.id } ??
            AVCaptureDevice.default(for: .audio)?.uniqueID ?? devices[0].id
        guard let selectedDevice = AudioInputDevice.discoveredDevices().first(where: { $0.uniqueID == selectedUID }) else {
            throw AudioRecorderError.deviceSelectionFailed
        }
        let input = try AVCaptureDeviceInput(device: selectedDevice)
        let session = AVCaptureSession()
        let output = AVCaptureAudioDataOutput()
        output.audioSettings = Self.captureAudioSettings
        guard session.canAddInput(input), session.canAddOutput(output) else {
            throw AudioRecorderError.couldNotStart
        }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("desktop-pets-voice-\(UUID().uuidString).wav")
        session.beginConfiguration()
        session.addInput(input)
        session.addOutput(output)
        session.commitConfiguration()

        let pipeline = try AudioCapturePipeline(outputURL: url)
        let statistics = AudioCaptureStatistics()
        let captureDelegate = AudioCaptureDelegate(pipeline: pipeline, statistics: statistics) { [weak self] level in
            Task { @MainActor in
                guard let self else { return }
                self.peakLevel = max(self.peakLevel, level)
                self.onInputLevel?(level)
            }
        }
        output.setSampleBufferDelegate(captureDelegate, queue: sampleQueue)
        sessionErrorObserver = NotificationCenter.default.addObserver(
            forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: .main
        ) { [weak self, weak statistics] notification in
            let error = notification.userInfo?[AVCaptureSessionErrorKey] as? NSError
            statistics?.recordSessionError(error?.code ?? 0)
            Task { @MainActor in
                self?.onDiagnostic?("speech.capture.session-error code=\(error?.code ?? 0)")
            }
        }
        self.captureSession = session
        self.captureOutput = output
        self.captureDelegate = captureDelegate
        self.pipeline = pipeline
        self.statistics = statistics
        self.lastCaptureSummary = .empty
        self.peakLevel = 0
        session.startRunning()
        guard session.isRunning else { throw AudioRecorderError.couldNotStart }
        let isDefault = selectedUID == AVCaptureDevice.default(for: .audio)?.uniqueID
        onDiagnostic?("speech.capture.session-started selected-default=\(isDefault) output=pcm-float32-48000-mono")
        limitTimer?.invalidate()
        limitTimer = Timer.scheduledTimer(withTimeInterval: duration, repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.onLimitReached?(self.stop())
            }
        }
    }

    @discardableResult
    private func stopCapture(deleteFile: Bool) -> URL? {
        if let pending = pendingPermission {
            pendingPermission = nil
            pending.completion(.failure(AudioRecorderError.cancelled))
        }
        limitTimer?.invalidate()
        limitTimer = nil
        guard let captureSession else { return nil }
        let url = pipeline?.url
        captureSession.stopRunning()
        captureOutput?.setSampleBufferDelegate(nil, queue: nil)
        sampleQueue.sync {}
        if let sessionErrorObserver {
            NotificationCenter.default.removeObserver(sessionErrorObserver)
            self.sessionErrorObserver = nil
        }
        pipeline?.finish()
        let summary = statistics?.snapshot ?? .empty
        lastCaptureSummary = summary
        onDiagnostic?("speech.capture.summary result=\(summary.resultDescription) sample-buffers=\(summary.sampleBuffers) decoded-buffers=\(summary.decodedBuffers) written-buffers=\(summary.writtenBuffers) first-error=\(summary.firstFailure ?? "none") session-error=\(summary.sessionErrorCode.map(String.init) ?? "none")")
        pipeline = nil
        statistics = nil
        captureOutput = nil
        captureDelegate = nil
        self.captureSession = nil
        guard let url, FileManager.default.fileExists(atPath: url.path) else { return nil }
        if deleteFile {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        guard summary.writtenBuffers > 0 else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
        return size > 44 ? url : nil
    }

    private static let captureAudioSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 48_000,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 32,
        AVLinearPCMIsFloatKey: true,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
    ]
}

private final class AudioCaptureStatistics: @unchecked Sendable {
    private let lock = NSLock()
    private var sampleBuffers = 0
    private var decodedBuffers = 0
    private var writtenBuffers = 0
    private var firstFailure: String?
    private var sessionErrorCode: Int?

    var snapshot: AudioCaptureSummary {
        lock.lock()
        defer { lock.unlock() }
        return AudioCaptureSummary(sampleBuffers: sampleBuffers, decodedBuffers: decodedBuffers,
                                   writtenBuffers: writtenBuffers, firstFailure: firstFailure,
                                   sessionErrorCode: sessionErrorCode)
    }

    func recordSample(result: AudioCapturePipeline.Result) {
        lock.lock()
        defer { lock.unlock() }
        sampleBuffers += 1
        switch result {
        case .written:
            decodedBuffers += 1
            writtenBuffers += 1
        case .failed(let stage, let decoded):
            if decoded { decodedBuffers += 1 }
            if firstFailure == nil { firstFailure = stage }
        }
    }

    func recordSessionError(_ code: Int) {
        lock.lock()
        sessionErrorCode = code
        lock.unlock()
    }
}

private extension AudioCaptureSummary {
    static let empty = AudioCaptureSummary(sampleBuffers: 0, decodedBuffers: 0, writtenBuffers: 0,
                                           firstFailure: nil, sessionErrorCode: nil)
}

final class AudioCapturePipeline: @unchecked Sendable {
    enum Result {
        case written(level: Float)
        case failed(stage: String, decoded: Bool)
    }

    let url: URL
    private let outputFormat: AVAudioFormat
    private var file: AVAudioFile?

    init(outputURL: URL) throws {
        url = outputURL
        guard let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000,
                                               channels: 1, interleaved: true) else {
            throw PipelineError.converterUnavailable
        }
        self.outputFormat = outputFormat
        file = try AVAudioFile(forWriting: outputURL, settings: outputFormat.settings)
    }

    func process(_ sampleBuffer: CMSampleBuffer) -> Result {
        let input: AVAudioPCMBuffer
        switch Self.pcmBuffer(from: sampleBuffer) {
        case .success(let buffer): input = buffer
        case .failure(let failure): return .failed(stage: failure.rawValue, decoded: false)
        }
        let measuredLevel = level(of: input)
        guard let file else { return .failed(stage: "output-closed", decoded: true) }
        guard let converted = downsample(input, to: file.processingFormat) else {
            return .failed(stage: "pcm-convert", decoded: true)
        }
        do {
            try file.write(from: converted)
        } catch {
            return .failed(stage: "wav-write", decoded: true)
        }
        return .written(level: measuredLevel)
    }

    func finish() { file = nil }

    // AVCaptureAudioDataOutput is fixed to 48 kHz for this pipeline. A small
    // deterministic reducer avoids AVAudioConverter rejecting manually-owned
    // sample buffers on some macOS input routes while still producing the
    // 16 kHz mono PCM expected by the local ASR model.
    private func downsample(_ input: AVAudioPCMBuffer, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        guard input.format.channelCount == 1,
              input.format.commonFormat == .pcmFormatFloat32,
              format.channelCount == 1,
              (format.commonFormat == .pcmFormatFloat32 || format.commonFormat == .pcmFormatInt16),
              input.frameLength > 0 else { return nil }
        let inputRate = input.format.sampleRate
        let outputRate = format.sampleRate
        guard inputRate > outputRate else { return nil }
        let inputFrames = Int(input.frameLength)
        let outputFrames = max(1, Int(ceil(Double(inputFrames) * outputRate / inputRate)))
        let bytesPerSample: Int
        switch format.commonFormat {
        case .pcmFormatFloat32: bytesPerSample = MemoryLayout<Float>.size
        case .pcmFormatInt16: bytesPerSample = MemoryLayout<Int16>.size
        default: return nil
        }
        guard let output = AVAudioPCMBuffer(pcmFormat: format,
                                             frameCapacity: AVAudioFrameCount(outputFrames)) else {
            return nil
        }
        output.frameLength = AVAudioFrameCount(outputFrames)
        let inputBuffers = UnsafeMutableAudioBufferListPointer(input.mutableAudioBufferList)
        let outputBuffers = UnsafeMutableAudioBufferListPointer(output.mutableAudioBufferList)
        guard inputBuffers.count == 1, outputBuffers.count == 1,
              inputBuffers[0].mNumberChannels == 1,
              outputBuffers[0].mNumberChannels == 1,
              output.frameCapacity >= AVAudioFrameCount(outputFrames),
              let sourceData = inputBuffers[0].mData,
              let destinationData = outputBuffers[0].mData,
              Int(outputBuffers[0].mDataByteSize) >= outputFrames * bytesPerSample else {
            return nil
        }
        let source = sourceData.assumingMemoryBound(to: Float.self)
        if format.commonFormat == .pcmFormatFloat32 {
            let destination = destinationData.assumingMemoryBound(to: Float.self)
            for outputIndex in 0..<outputFrames {
                destination[outputIndex] = averagedSample(source, outputIndex: outputIndex,
                                                          inputFrames: inputFrames,
                                                          inputRate: inputRate, outputRate: outputRate)
            }
        } else {
            let destination = destinationData.assumingMemoryBound(to: Int16.self)
            for outputIndex in 0..<outputFrames {
                let sample = averagedSample(source, outputIndex: outputIndex, inputFrames: inputFrames,
                                            inputRate: inputRate, outputRate: outputRate)
                destination[outputIndex] = Int16((sample * 32767).rounded())
            }
        }
        outputBuffers[0].mDataByteSize = UInt32(outputFrames * bytesPerSample)
        return output
    }

    private func averagedSample(_ source: UnsafePointer<Float>, outputIndex: Int, inputFrames: Int,
                                inputRate: Double, outputRate: Double) -> Float {
        let start = min(inputFrames - 1, Int(floor(Double(outputIndex) * inputRate / outputRate)))
        let end = min(inputFrames, max(start + 1,
                                       Int(ceil(Double(outputIndex + 1) * inputRate / outputRate))))
        var sum: Float = 0
        for inputIndex in start..<end { sum += source[inputIndex] }
        return max(-1, min(1, sum / Float(end - start)))
    }

    enum PCMDecodeFailure: String, Error {
        case formatDescription = "sample-format-missing"
        case unsupportedFormat = "sample-format-unexpected"
        case emptySample = "sample-empty"
        case missingData = "sample-data-missing"
        case dataTooShort = "sample-data-short"
        case dataCopy = "sample-data-copy"
        case audioFormat = "pcm-format-create"
        case audioBuffer = "pcm-buffer-create"
        case audioBufferList = "pcm-buffer-list"
        case audioBufferChannels = "pcm-buffer-channels"
        case audioBufferData = "pcm-buffer-data"
        case audioBufferCapacity = "pcm-buffer-capacity"
    }

    static func pcmBuffer(from sampleBuffer: CMSampleBuffer) -> Swift.Result<AVAudioPCMBuffer, PCMDecodeFailure> {
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let description = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)?.pointee else {
            return .failure(.formatDescription)
        }
        guard description.mFormatID == kAudioFormatLinearPCM,
              description.mChannelsPerFrame == 1,
              description.mBitsPerChannel == 32,
              description.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              abs(description.mSampleRate - 48_000) < 1 else {
            return .failure(.unsupportedFormat)
        }
        let frameCountValue = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frameCountValue > 0,
              frameCountValue <= Int(Int.max / MemoryLayout<Float>.size) else { return .failure(.emptySample) }
        let frameCount = AVAudioFrameCount(frameCountValue)
        let requiredBytes = frameCountValue * MemoryLayout<Float>.size
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return .failure(.missingData) }
        guard CMBlockBufferGetDataLength(blockBuffer) >= requiredBytes else { return .failure(.dataTooShort) }
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: description.mSampleRate,
                                         channels: 1, interleaved: true) else { return .failure(.audioFormat) }
        guard let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
            return .failure(.audioBuffer)
        }
        pcm.frameLength = frameCount
        let destinationBuffers = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
        guard destinationBuffers.count == 1 else { return .failure(.audioBufferList) }
        guard destinationBuffers[0].mNumberChannels == 1 else { return .failure(.audioBufferChannels) }
        guard let destination = destinationBuffers[0].mData else { return .failure(.audioBufferData) }
        guard Int(destinationBuffers[0].mDataByteSize) >= requiredBytes else {
            return .failure(.audioBufferCapacity)
        }
        let copyStatus = CMBlockBufferCopyDataBytes(
            blockBuffer, atOffset: 0, dataLength: requiredBytes,
            destination: destination.assumingMemoryBound(to: Int8.self)
        )
        guard copyStatus == kCMBlockBufferNoErr else { return .failure(.dataCopy) }
        return .success(pcm)
    }

    private func level(of buffer: AVAudioPCMBuffer) -> Float {
        guard buffer.format.commonFormat == .pcmFormatFloat32,
              let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
        let frameCount = Int(buffer.frameLength)
        var sum: Float = 0
        for channel in 0..<Int(buffer.format.channelCount) {
            for frame in 0..<frameCount {
                let sample = channels[channel][frame]
                sum += sample * sample
            }
        }
        let rms = sqrt(sum / Float(frameCount * Int(buffer.format.channelCount)))
        return min(1, rms * 4)
    }

    private enum PipelineError: Error { case converterUnavailable }
}

private final class AudioCaptureDelegate: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let pipeline: AudioCapturePipeline
    private let statistics: AudioCaptureStatistics
    private let onInputLevel: @Sendable (Float) -> Void

    init(pipeline: AudioCapturePipeline, statistics: AudioCaptureStatistics,
         onInputLevel: @escaping @Sendable (Float) -> Void) {
        self.pipeline = pipeline
        self.statistics = statistics
        self.onInputLevel = onInputLevel
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        let result = pipeline.process(sampleBuffer)
        statistics.recordSample(result: result)
        if case .written(let level) = result { onInputLevel(level) }
    }
}

private enum AudioRecorderError: LocalizedError {
    case permissionDenied
    case cancelled
    case devicesUnavailable
    case noInputDevice
    case deviceSelectionFailed
    case couldNotStart

    var errorDescription: String? {
        switch self {
        case .cancelled: "录音已取消，没有启动麦克风。"
        case .permissionDenied: "未获麦克风权限；可在系统设置的隐私与安全性中允许桌边小崽使用麦克风。"
        case .devicesUnavailable: "无法读取 macOS 音频设备列表。"
        case .noInputDevice: "没有找到可用的麦克风输入设备。"
        case .deviceSelectionFailed: "无法切换到所选麦克风；请重新选择设备后重试。"
        case .couldNotStart: "无法启动所选麦克风。"
        }
    }
}
