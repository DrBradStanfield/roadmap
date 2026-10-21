import XCTest
@testable import HealthRoadmap

/// US-25 AC11e, AC11f: the words that say where the record is. Every privacy
/// sentence must match what the code does (US-09 decisions, 2026-09-10).
final class SyncStatusTextTests: XCTestCase {
    func testNotConnectedSaysThePhoneOnly() {
        XCTAssertEqual(SyncStatusText.headline(.onPhone, provider: nil), "On this iPhone only")
        XCTAssertEqual(SyncStatusText.planPrivacy(provider: nil), "No health data left your device.")
        XCTAssertTrue(SyncStatusText.myDataFooter(provider: nil).hasPrefix("Saved only on this iPhone"))
    }

    func testConnectedNamesTheCloudAndNeverClaimsTheDataStayed() {
        XCTAssertEqual(SyncStatusText.headline(.synced(.now), provider: .dropbox), "Synced with Dropbox")
        XCTAssertEqual(SyncStatusText.headline(.saving, provider: .googleDrive), "Saving to Google Drive…")
        XCTAssertFalse(SyncStatusText.planPrivacy(provider: .dropbox).contains("left your device"))
        XCTAssertTrue(SyncStatusText.planPrivacy(provider: .dropbox).contains("Dropbox"))
        XCTAssertTrue(SyncStatusText.myDataFooter(provider: .dropbox).contains("Dropbox"))
    }

    func testAProblemSaysTheChangesAreSafeOnThePhone() {
        for kind in [SyncProblem.Kind.unreachable, .signIn, .tooNew] {
            let words = SyncStatusText.detail(.problem(SyncProblem(kind: kind)), provider: .dropbox) ?? ""
            XCTAssertTrue(words.contains("on this iPhone"), words)
        }
        XCTAssertEqual(SyncProblem(json: #"{"kind":"sign-in","detail":"x"}"#).kind, .signIn)
        XCTAssertEqual(SyncProblem(json: "not json").kind, .unreachable)
    }
}
