import UIKit
import XCTest
@testable import HealthRoadmap

/// US-25 AC19 (D9, amended 2026-10-22): Clarity sees every screen masked. The window
/// is masked before Clarity starts, every text input is masked on its own, screen
/// names are fixed words, and no code anywhere unmasks a view.
@MainActor
final class AnalyticsMaskingTests: XCTestCase {
    private final class FakeSDK: AnalyticsSDK {
        var calls: [String] = []
        func mask(_ view: UIView) { calls.append(view is UIWindow ? "mask window" : "mask view") }
        func start(projectId: String) -> Bool { calls.append("start \(projectId)"); return true }
        func screen(_ name: String) { calls.append("screen \(name)") }
        func event(_ name: String) { calls.append("event \(name)") }
    }

    func testTheWindowIsMaskedBeforeClarityStarts_AC19() {
        let sdk = FakeSDK()
        let analytics = Analytics(sdk: sdk, projectId: "abc", testing: false)
        XCTAssertTrue(analytics.start(in: UIWindow()))
        XCTAssertFalse(analytics.start(in: UIWindow()), "once per launch")
        XCTAssertEqual(sdk.calls, ["mask window", "start abc", "screen Welcome"])
    }

    func testScreenNamesAreFixedWords_AC19() {
        let sdk = FakeSDK()
        let analytics = Analytics(sdk: sdk, projectId: "abc", testing: false)
        analytics.screen(.plan)
        XCTAssertEqual(sdk.calls, [], "nothing before Clarity starts")
        analytics.start(in: UIWindow())
        analytics.screen(.myData)
        XCTAssertEqual(sdk.calls.last, "screen My data")
    }

    /// US-57's usage signal (D9, Brad 2026-10-25): exactly these fixed words, no value and no
    /// tile name, and nothing before Clarity starts.
    func testEventsAreExactlyTheFixedWords_US57() {
        XCTAssertEqual(Analytics.Event.allCases.map(\.rawValue), [
            "Tour started",
            "Tour tip closed 1", "Tour tip closed 2", "Tour tip closed 3",
            "Tour skipped 1", "Tour skipped 2", "Tour skipped 3",
            "Tile explainer opened",
            "Cloud prompt shown", "Cloud prompt back up", "Cloud prompt not now",
            "Guide seen", "Guide opened", // US-58's usage signal: no metric or medicine name
        ])
        let sdk = FakeSDK()
        let analytics = Analytics(sdk: sdk, projectId: "abc", testing: false)
        analytics.event(.tourStarted)
        XCTAssertEqual(sdk.calls, [], "nothing before Clarity starts")
        analytics.start(in: UIWindow())
        analytics.event(.tileExplainerOpened)
        XCTAssertEqual(sdk.calls.last, "event Tile explainer opened")
    }

    func testEachTourTipHasItsOwnClosedAndSkippedWords_US57() {
        XCTAssertEqual(Analytics.Event.tip(.snapshot, skipped: false), .tourTipClosed1)
        XCTAssertEqual(Analytics.Event.tip(.foundation, skipped: false), .tourTipClosed2)
        XCTAssertEqual(Analytics.Event.tip(.bloodTests, skipped: false), .tourTipClosed3)
        XCTAssertEqual(Analytics.Event.tip(.snapshot, skipped: true), .tourSkipped1)
        XCTAssertEqual(Analytics.Event.tip(.foundation, skipped: true), .tourSkipped2)
        XCTAssertEqual(Analytics.Event.tip(.bloodTests, skipped: true), .tourSkipped3)
        XCTAssertNil(Analytics.Event.tip(.notStarted, skipped: false))
        XCTAssertNil(Analytics.Event.tip(.done, skipped: true))
    }

    func testNoProjectIdMeansClarityStaysOff_AC19() {
        let sdk = FakeSDK()
        XCTAssertFalse(Analytics(sdk: sdk, projectId: nil, testing: false).start(in: UIWindow()))
        XCTAssertFalse(Analytics(sdk: sdk, projectId: "", testing: false).start(in: UIWindow()))
        XCTAssertEqual(sdk.calls, [])
    }

    func testClarityNeverRunsUnderUnitOrUITests_AC19() {
        let sdk = FakeSDK()
        XCTAssertTrue(Analytics.isTesting(environment: ["XCTestConfigurationFilePath": "x"], arguments: []))
        XCTAssertTrue(Analytics.isTesting(environment: [:], arguments: ["app", Analytics.uiTestingArgument]))
        XCTAssertFalse(Analytics.isTesting(environment: [:], arguments: ["app"]))
        XCTAssertFalse(Analytics(sdk: sdk, projectId: "abc", testing: true).start(in: UIWindow()))
        XCTAssertEqual(sdk.calls, [])
    }

    /// Nothing may lift the mask, every text input is masked, and only Analytics.swift talks to Clarity.
    func testNoCodeUnmasksAndEveryInputIsMasked_AC19() throws {
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path: "HealthRoadmap")
        guard FileManager.default.fileExists(atPath: app.path(percentEncoded: false)) else {
            throw XCTSkip("The app's sources are not on this device (a real iPhone); the simulator run checks them.")
        }
        let files = try XCTUnwrap(FileManager.default.enumerator(at: app, includingPropertiesForKeys: nil))
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
        XCTAssertGreaterThan(files.count, 20, "the app's sources were found")
        let input = try NSRegularExpression(pattern: #"\b(TextField|TextEditor|SecureField)\("#)
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            let name = file.lastPathComponent
            for banned in ["clarityUnmask", "unmaskView"] {
                XCTAssertFalse(text.contains(banned), "\(name) uses \(banned): nothing is ever unmasked")
            }
            if name != "Analytics.swift" {
                XCTAssertFalse(text.contains("ClaritySDK") || text.contains(".clarityMask("), "\(name) calls Clarity directly; go through Analytics")
            }
            let inputs = input.numberOfMatches(in: text, range: NSRange(text.startIndex..., in: text))
            let masked = text.components(separatedBy: ".analyticsMasked()").count - 1
            XCTAssertGreaterThanOrEqual(masked, inputs, "\(name) has a text input without .analyticsMasked()")
        }
    }
}
