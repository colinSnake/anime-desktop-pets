import XCTest
import CoreGraphics
@testable import DragonCore

final class StartupPresentationTests: XCTestCase {
    func testWideClientBecomesVideoAspectNotPillarboxedVideo() {
        let visible = CGRect(x: 0, y: 30, width: 1920, height: 1050)
        let frame = StartupPresentation.videoFrame(near: CGRect(x: 40, y: 150, width: 1600, height: 600),
                                                    visible: visible, maximumWidth: 1280)
        XCTAssertEqual(frame.width, 1280)
        XCTAssertEqual(frame.height, 720)
        XCTAssertTrue(visible.contains(frame))
    }
    func testPortraitScreenFitsHeightAndPreservesAspect() {
        let visible = CGRect(x: -1080, y: -400, width: 1080, height: 1880)
        let frame = StartupPresentation.videoFrame(near: nil, visible: visible, maximumWidth: 1280)
        XCTAssertEqual(frame.width / frame.height, 16.0 / 9, accuracy: 0.000001)
        XCTAssertTrue(visible.contains(frame))
    }
    func testSmallScreenLimitsHeight() {
        let visible = CGRect(x: 0, y: 0, width: 900, height: 400)
        let frame = StartupPresentation.videoFrame(near: nil, visible: visible, maximumWidth: 1280)
        XCTAssertEqual(frame.height, 360)
        XCTAssertTrue(visible.contains(frame))
    }
    func testOffscreenCenterClampsToSelectedScreen() {
        let visible = CGRect(x: 1920, y: 20, width: 1600, height: 900)
        let frame = StartupPresentation.videoFrame(near: CGRect(x: -3000, y: 3000, width: 100, height: 100),
                                                    visible: visible, maximumWidth: 1280)
        XCTAssertTrue(visible.contains(frame))
        XCTAssertEqual(frame.width / frame.height, 16.0 / 9, accuracy: 0.000001)
    }
    func testAXCoordinateConversionRoundTripsUpperAndLeftDisplays() {
        for frame in [CGRect(x: -1300, y: 400, width: 1280, height: 720),
                      CGRect(x: 300, y: 1500, width: 1280, height: 720)] {
            let ax = StartupPresentation.flippedFrame(frame, primaryTop: 1080)
            XCTAssertEqual(StartupPresentation.flippedFrame(ax, primaryTop: 1080), frame)
        }
    }
    func testActualFrameComparisonIncludesBothSizeAndPosition() {
        let a = CGRect(x: 10, y: 20, width: 1280, height: 720)
        XCTAssertTrue(StartupPresentation.framesMatch(a, a.offsetBy(dx: 1, dy: -1)))
        XCTAssertFalse(StartupPresentation.framesMatch(a, a.offsetBy(dx: 10, dy: 0)))
        XCTAssertFalse(StartupPresentation.framesMatch(a, CGRect(x: 10, y: 20, width: 1400, height: 720)))
    }
    func testCoveringOpacityNeverBecomesFullyOccludingIncludingAfterWait() {
        for opacity in stride(from: 0.0, through: 1.0, by: 0.05) {
            let result = StartupPresentation.opacity(opacity, coveringClient: true)
            XCTAssertLessThan(result, 1)
            XCTAssertLessThanOrEqual(result, opacity)
        }
        XCTAssertEqual(StartupPresentation.opacity(1, coveringClient: true), 0.999)
        XCTAssertEqual(StartupPresentation.opacity(0, coveringClient: true), 0)
        XCTAssertEqual(StartupPresentation.opacity(1, coveringClient: false), 1)
    }
    func testOcclusionSwitchDoesNotExposeDebuggingPortOrDisableAllBackgroundThrottling() {
        XCTAssertEqual(StartupPresentation.chromiumLaunchArguments, ["--disable-backgrounding-occluded-windows"])
    }
}
