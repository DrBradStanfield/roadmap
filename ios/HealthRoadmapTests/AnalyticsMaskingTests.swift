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
        analytics.screen(.chat)
        XCTAssertEqual(sdk.calls, [], "nothing before Clarity starts")
        analytics.start(in: UIWindow())
        analytics.screen(.myHealth)
        XCTAssertEqual(sdk.calls.last, "screen My health")
    }

    /// US-57's usage signal (D9, Brad 2026-10-25): exactly these fixed words, no value and no
    /// tile name, and nothing before Clarity starts.
    func testEventsAreExactlyTheFixedWords_US57() {
        XCTAssertEqual(Analytics.Event.allCases.map(\.rawValue), [
            "Tour started",
            "Tour tip closed 1", "Tour tip closed 2", "Tour tip closed 3",
            "Tour skipped 1", "Tour skipped 2", "Tour skipped 3",
            "Cloud prompt shown", "Cloud prompt back up", "Cloud prompt not now",
            "Guide seen", "Guide opened", // US-58's usage signal: no metric or medicine name
            "Alcohol answered", // US-60's usage signal: never the answer
            "Chat edit proposed", "Chat edit saved", // US-67 AC6: never a value or field name
            "Health Records asked", "Health Records imported", // US-72 AC13: never a value, a test's name or a count
            "Jump pill tapped", "Blood test added", // US-73's usage signal: never which pill, test or value
            "Lab save all", "Lab save one", // US-52 AC8b: once per save action, never a count or a name
        ])
        let sdk = FakeSDK()
        let analytics = Analytics(sdk: sdk, projectId: "abc", testing: false)
        analytics.event(.tourStarted)
        XCTAssertEqual(sdk.calls, [], "nothing before Clarity starts")
        analytics.start(in: UIWindow())
        analytics.event(.guideSeen)
        XCTAssertEqual(sdk.calls.last, "event Guide seen")
    }

    /// S44: a launch's own event (a first-run finish's "Tour started") fired before the window
    /// reader starts Clarity is sent once it starts, after the screen; later ones go straight through.
    func testAnEventBeforeStartIsSentOnceClarityStarts_S44() {
        let sdk = FakeSDK()
        let analytics = Analytics(sdk: sdk, projectId: "abc", testing: false)
        analytics.event(.tourStarted)
        analytics.event(.cloudPromptShown)
        XCTAssertEqual(sdk.calls, [], "nothing before Clarity starts")
        analytics.start(in: UIWindow())
        XCTAssertEqual(sdk.calls, ["mask window", "start abc", "screen Welcome", "event Tour started", "event Cloud prompt shown"])
        analytics.event(.guideSeen)
        XCTAssertFalse(analytics.start(in: UIWindow()), "once per launch")
        XCTAssertEqual(sdk.calls.suffix(1), ["event Guide seen"], "after start, straight through, nothing sent twice")
        XCTAssertEqual(sdk.calls.filter { $0 == "event Tour started" }.count, 1)
    }

    /// S44: the wait holds at most the newest `earlyLimit` events; older ones are dropped.
    func testTheWaitBeforeStartIsBounded_S44() {
        let sdk = FakeSDK()
        let analytics = Analytics(sdk: sdk, projectId: "abc", testing: false)
        analytics.event(.tourStarted)
        for _ in 0..<Analytics.earlyLimit { analytics.event(.guideSeen) }
        analytics.start(in: UIWindow())
        let events = sdk.calls.filter { $0.hasPrefix("event ") }
        XCTAssertEqual(events, Array(repeating: "event Guide seen", count: Analytics.earlyLimit), "the oldest went")
    }

    /// S44: where Clarity never starts (under the tests, no project id, or a failed start),
    /// waiting events never reach it.
    func testWaitingEventsNeverReachClarityWhenItDoesNotStart_S44() {
        let sdk = FakeSDK()
        for analytics in [Analytics(sdk: sdk, projectId: "abc", testing: true), Analytics(sdk: sdk, projectId: nil, testing: false)] {
            analytics.event(.tourStarted)
            XCTAssertFalse(analytics.start(in: UIWindow()))
            analytics.event(.guideSeen)
        }
        XCTAssertEqual(sdk.calls, [])
        let refusing = RefusingSDK()
        let analytics = Analytics(sdk: refusing, projectId: "abc", testing: false)
        analytics.event(.tourStarted)
        XCTAssertFalse(analytics.start(in: UIWindow()))
        XCTAssertEqual(refusing.calls, ["mask window", "start abc"], "a refused start sends no event")
    }

    /// S44: the phase's whole table.
    func testThePhaseTransitions_S44() {
        typealias A = Analytics
        let full = Array(repeating: A.Event.guideSeen, count: A.earlyLimit)
        let table: [(A.Phase, A.Step, A.Phase)] = [
            (.waiting(early: []), .fired(.tourStarted), .waiting(early: [.tourStarted])),
            (.waiting(early: [.tourStarted]), .fired(.guideSeen), .waiting(early: [.tourStarted, .guideSeen])),
            (.waiting(early: [.tourStarted] + full.dropLast()), .fired(.guideSeen), .waiting(early: full)),
            (.waiting(early: [.tourStarted]), .started, .started),
            (.started, .fired(.tourStarted), .started),
            (.started, .started, .started),
        ]
        for (from, step, to) in table { XCTAssertEqual(A.transition(from, step), to, "\(from) + \(step)") }
    }

    private final class RefusingSDK: AnalyticsSDK {
        var calls: [String] = []
        func mask(_ view: UIView) { calls.append(view is UIWindow ? "mask window" : "mask view") }
        func start(projectId: String) -> Bool { calls.append("start \(projectId)"); return false }
        func screen(_ name: String) { calls.append("screen \(name)") }
        func event(_ name: String) { calls.append("event \(name)") }
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
