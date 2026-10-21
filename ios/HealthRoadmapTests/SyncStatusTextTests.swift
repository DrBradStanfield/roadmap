import XCTest
@testable import HealthRoadmap

/// US-25 AC11e, AC11f: the words that say where the record is. Every privacy
/// sentence must match what the code does (US-09 decisions, 2026-09-10).
final class SyncStatusTextTests: XCTestCase {
    func testNotConnectedSaysThePhoneOnly() {
        XCTAssertEqual(SyncStatusText.headline(.onPhone, provider: nil), "On this iPhone only")
        XCTAssertEqual(SyncStatusText.planPrivacy(provider: nil, earlier: nil), "No health data left your device.")
        XCTAssertTrue(SyncStatusText.myDataFooter(provider: nil, earlier: nil).hasPrefix("Saved only on this iPhone"))
    }

    func testConnectedNamesTheCloudAndNeverClaimsTheDataStayed() {
        XCTAssertEqual(SyncStatusText.headline(.synced(.now), provider: .dropbox), "Synced with Dropbox")
        XCTAssertEqual(SyncStatusText.headline(.saving, provider: .googleDrive), "Saving to Google Drive…")
        XCTAssertFalse(SyncStatusText.planPrivacy(provider: .dropbox, earlier: .dropbox).contains("left your device"))
        XCTAssertTrue(SyncStatusText.planPrivacy(provider: .dropbox, earlier: .dropbox).contains("Dropbox"))
        XCTAssertTrue(SyncStatusText.myDataFooter(provider: .dropbox, earlier: .dropbox).contains("Dropbox"))
    }

    func testAProblemSaysTheChangesAreSafeOnThePhone() {
        for kind in [SyncProblem.Kind.unreachable, .signIn, .tooNew] {
            let words = SyncStatusText.detail(.problem(SyncProblem(kind: kind)), provider: .dropbox) ?? ""
            XCTAssertTrue(words.contains("on this iPhone"), words)
        }
        XCTAssertEqual(SyncProblem(json: #"{"kind":"sign-in","detail":"x"}"#).kind, .signIn)
        XCTAssertEqual(SyncProblem(json: "not json").kind, .unreachable)
    }

    /// Adversary A3: after Disconnect the record is still in the cloud, so the
    /// words must not say it never left the phone.
    func testAfterDisconnectNothingClaimsTheDataNeverLeft() {
        let plan = SyncStatusText.planPrivacy(provider: nil, earlier: .dropbox)
        let footer = SyncStatusText.myDataFooter(provider: nil, earlier: .dropbox)
        XCTAssertFalse(plan.contains("left your device"), plan)
        XCTAssertFalse(footer.contains("only"), footer)
        XCTAssertTrue(plan.contains("Dropbox") && footer.contains("Dropbox"))
    }
}
