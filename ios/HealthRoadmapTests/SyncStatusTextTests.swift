import XCTest
@testable import HealthRoadmap

/// US-25 AC11e, AC11f: the words that say where the record is. Every privacy
/// sentence must match what the code does (US-09 decisions, 2026-09-10).
final class SyncStatusTextTests: XCTestCase {
    func testNotConnectedSaysThePhoneOnly() {
        XCTAssertEqual(SyncStatusText.headline(.onPhone, provider: nil), "On this iPhone only")
        XCTAssertTrue(SyncStatusText.myDataFooter(provider: nil, earlier: nil).hasPrefix("Saved only on this iPhone"))
    }

    func testConnectedNamesTheCloudAndNeverClaimsTheDataStayed() {
        XCTAssertEqual(SyncStatusText.headline(.synced(.now), provider: .dropbox), "Synced with Dropbox")
        XCTAssertEqual(SyncStatusText.headline(.saving, provider: .googleDrive), "Saving to Google Drive…")
        XCTAssertTrue(SyncStatusText.myDataFooter(provider: .dropbox, earlier: .dropbox).contains("Dropbox"))
    }

    func testAProblemSaysTheChangesAreSafeOnThePhone() {
        for kind in [SyncProblem.Kind.unreachable, .signIn, .tooNew, .storageFull, .busy] {
            let words = SyncStatusText.detail(.problem(SyncProblem(kind: kind)), provider: .dropbox) ?? ""
            XCTAssertTrue(words.contains("on this iPhone"), words)
        }
        XCTAssertEqual(SyncProblem(json: #"{"kind":"sign-in","detail":"x"}"#).kind, .signIn)
        XCTAssertEqual(SyncProblem(json: "not json").kind, .unreachable)
        XCTAssertEqual(SyncProblem(json: #"{"kind":"storage-full"}"#).kind, .storageFull)
        XCTAssertFalse(SyncProblem(kind: .storageFull).words(.googleDrive).contains("sign in"))
    }

    /// US-25 AC11e (2026-10-22): not connected is a phone, never a struck-out
    /// iCloud, which read as "iCloud is off"; each connected state has its own symbol.
    func testTheSymbolSaysPhoneOrCloudState() {
        XCTAssertEqual(SyncStatusText.symbol(.onPhone, provider: nil), "iphone")
        XCTAssertEqual(SyncStatusText.symbol(.synced(.now), provider: nil), "iphone")
        let connected = [CloudSync.Status.connecting, .saving, .synced(.now), .problem(SyncProblem(kind: .unreachable))]
            .map { SyncStatusText.symbol($0, provider: .dropbox) }
        XCTAssertEqual(Set(connected).count, 3, "connecting and saving share one symbol")
        for symbol in connected + ["iphone"] { XCTAssertFalse(symbol.contains("slash"), symbol) }
    }

    /// Adversary A3: after Disconnect the record is still in the cloud, so the
    /// words must not say it never left the phone.
    func testAfterDisconnectNothingClaimsTheDataNeverLeft() {
        let footer = SyncStatusText.myDataFooter(provider: nil, earlier: .dropbox)
        XCTAssertFalse(footer.contains("only"), footer)
        XCTAssertTrue(footer.contains("Dropbox"))
    }
}
