import XCTest
import AVFoundation
import CoreMedia
@testable import DragonCompanion

final class AudioCaptureSummaryTests: XCTestCase {
    func testSeparatesMissingSystemSamplesFromDecodeFailure() {
        let noSamples = AudioCaptureSummary(sampleBuffers: 0, decodedBuffers: 0, writtenBuffers: 0,
                                            firstFailure: nil, sessionErrorCode: nil)
        let decodeFailure = AudioCaptureSummary(sampleBuffers: 12, decodedBuffers: 0, writtenBuffers: 0,
                                                firstFailure: "pcm-buffer-capacity", sessionErrorCode: nil)

        XCTAssertEqual(noSamples.resultDescription, "no-sample-buffers")
        XCTAssertEqual(decodeFailure.resultDescription, "sample-decode-failed")
    }

    func testSeparatesPcmWriteFailureFromSuccessfulCapture() {
        let writeFailure = AudioCaptureSummary(sampleBuffers: 12, decodedBuffers: 12, writtenBuffers: 0,
                                               firstFailure: "wav-write", sessionErrorCode: nil)
        let captured = AudioCaptureSummary(sampleBuffers: 12, decodedBuffers: 12, writtenBuffers: 12,
                                           firstFailure: nil, sessionErrorCode: nil)

        XCTAssertEqual(writeFailure.resultDescription, "pcm-write-failed")
        XCTAssertEqual(captured.resultDescription, "audio-received")
    }

    func testInterleavedFloatSampleBufferIsDecodedAndDownsampledToWav() throws {
        let samples = (0..<480).map { Float($0 % 16) / 16.0 }

        let createdSampleBuffer = samples.withUnsafeBytes { bytes -> CMSampleBuffer? in
            var blockBuffer: CMBlockBuffer?
            let blockStatus = CMBlockBufferCreateWithMemoryBlock(
                allocator: kCFAllocatorDefault,
                memoryBlock: UnsafeMutableRawPointer(mutating: bytes.baseAddress!),
                blockLength: bytes.count,
                blockAllocator: kCFAllocatorNull,
                customBlockSource: nil,
                offsetToData: 0,
                dataLength: bytes.count,
                flags: 0,
                blockBufferOut: &blockBuffer
            )
            XCTAssertEqual(blockStatus, kCMBlockBufferNoErr)
            guard let blockBuffer else { return nil }

            var description = AudioStreamBasicDescription(
                mSampleRate: 48_000,
                mFormatID: kAudioFormatLinearPCM,
                mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
                mBytesPerPacket: 4,
                mFramesPerPacket: 1,
                mBytesPerFrame: 4,
                mChannelsPerFrame: 1,
                mBitsPerChannel: 32,
                mReserved: 0
            )
            var formatDescription: CMAudioFormatDescription?
            let formatStatus = CMAudioFormatDescriptionCreate(
                allocator: kCFAllocatorDefault,
                asbd: &description,
                layoutSize: 0,
                layout: nil,
                magicCookieSize: 0,
                magicCookie: nil,
                extensions: nil,
                formatDescriptionOut: &formatDescription
            )
            XCTAssertEqual(formatStatus, noErr)
            guard let formatDescription else { return nil }

            var sampleBuffer: CMSampleBuffer?
            let sampleStatus = CMSampleBufferCreateReady(
                allocator: kCFAllocatorDefault,
                dataBuffer: blockBuffer,
                formatDescription: formatDescription,
                sampleCount: samples.count,
                sampleTimingEntryCount: 0,
                sampleTimingArray: nil,
                sampleSizeEntryCount: 0,
                sampleSizeArray: nil,
                sampleBufferOut: &sampleBuffer
            )
            XCTAssertEqual(sampleStatus, noErr)
            return sampleBuffer
        }
        let sampleBuffer = try XCTUnwrap(createdSampleBuffer)
        let decoded = AudioCapturePipeline.pcmBuffer(from: sampleBuffer)

        guard case .success(let pcm) = decoded else {
            XCTFail("Expected interleaved Float32 PCM decode to succeed, got \(decoded)")
            return
        }
        XCTAssertEqual(pcm.frameLength, AVAudioFrameCount(samples.count))
        let buffers = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
        XCTAssertEqual(buffers.count, 1)
        XCTAssertEqual(buffers[0].mNumberChannels, 1)
        XCTAssertEqual(Int(buffers[0].mDataByteSize), samples.count * MemoryLayout<Float>.size)
        let decodedSamples = buffers[0].mData!.assumingMemoryBound(to: Float.self)
        XCTAssertEqual(decodedSamples[0], samples[0])
        XCTAssertEqual(decodedSamples[15], samples[15])

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("audio-capture-pipeline-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: url) }
        let pipeline = try AudioCapturePipeline(outputURL: url)
        let pipelineResult = pipeline.process(sampleBuffer)
        guard case .written = pipelineResult else {
            XCTFail("Expected decoded sample buffer to be downsampled and written, got \(pipelineResult)")
            return
        }
        pipeline.finish()
        let output = try AVAudioFile(forReading: url)
        XCTAssertEqual(output.processingFormat.sampleRate, 16_000)
        XCTAssertEqual(output.length, 160)
    }
}
