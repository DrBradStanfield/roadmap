import Foundation
import JavaScriptCore

/// The engine's cloud doors (ios/engine/cloud.ts, US-25 AC11). The sync itself,
/// save loop, merge and erase guard included, is health-core's, in JavaScript;
/// these only carry text across.
extension HealthEngine {
    /// The record and the erase it is at, as the engine hands them over.
    struct CloudView: Decodable, Equatable {
        let record: String
        let erase: String
        /// The engine session it came from; news from any other is dropped.
        let session: Int
        /// The engine's stamp, set in Swift (`stamp`): one stamped earlier is older.
        var order: Int? = nil
    }

    /// What a cloud session reports through the `notify` native (declared in
    /// ios/engine/cloud-adapters.ts `CloudNatives`; 'saving' and 'saved' are sent there,
    /// 'synced', 'failed' and 'changed' in cloud.ts), decoded on the engine's queue
    /// before it goes to the main thread (US-25 AC21).
    enum CloudNews: Equatable, Sendable {
        case saving, saved, synced
        /// The engine's failure, from its JSON (`{"kind": "...", "detail": "..."}`).
        case failed(SyncProblem)
        /// A record the session took in, carrying the engine's stamp.
        case changed(CloudView)
        /// An event this build does not know, or a record that did not decode: dropped.
        case other

        /// `order`: the engine's stamp when it was sent (`stamp`).
        init(_ event: String, _ payload: String, order: Int) {
            switch event {
            case "saving": self = .saving
            case "saved": self = .saved
            case "synced": self = .synced
            case "failed": self = .failed(SyncProblem(json: payload))
            case "changed":
                guard var view = try? JSONDecoder().decode(CloudView.self, from: Data(payload.utf8)) else { self = .other; return }
                view.order = order
                self = .changed(view)
            default: self = .other
            }
        }
    }

    /// A number that rises with every cloud record the engine hands to Swift, taken on
    /// the engine's queue. News reaches the main thread in this order, but an edit's
    /// answer may arrive after news of a re-read made before it: the screen keeps
    /// the record with the higher stamp (RecordStore).
    func stamp() -> Int { natives.stamp() }

    /// A door's answer as text, stamped as it resolves on the engine's queue, not when
    /// Swift's continuation runs: news sent after it is stamped later.
    var stamped: (JSValue) -> (String, Int) {
        { [natives] answer in (answer.isUndefined ? "" : answer.toString(), natives.stamp()) }
    }

    /// Open the cloud record. `firstConnect` merges the phone's record up first.
    /// `mergePhone`: the phone took edits while an earlier open ran, so the session
    /// merges the phone's file in whatever its marker says.
    /// Throws `EngineError.callFailed` whose text is the failure's JSON (`SyncProblem`).
    func cloudOpen(provider: CloudProvider, deviceId: String, firstConnect: Bool, mergePhone: Bool = false) async throws -> CloudView {
        let (json, order) = try await doorCloudOpen(provider: provider.rawValue, deviceId: deviceId, firstConnect: firstConnect, mergePhone: mergePhone, read: stamped)
        var view = try JSONDecoder().decode(CloudView.self, from: Data(json.utf8))
        view.order = order
        return view
    }

    /// One My data edit through the open session, checked against the erase and the
    /// units the screen showed when the edit began (a sheet's opening).
    /// `choices`: the per-test units the sheet showed (US-25 AC17e), as JSON.
    /// `order`: the engine's stamp, taken as it answers (`stamp`).
    func cloudEdit(_ edit: RecordEdit, erase: String, units: String, now: Date, choices: String = "{}", lpaUnit: String) throws -> (outcome: EditOutcome, order: Int) {
        let editJSON = String(decoding: try JSONEncoder().encode(edit), as: UTF8.self)
        let outcome = try doorCloudEdit(editJson: editJSON, erase: erase, shownUnits: units, nowIso: now.formatted(Self.iso), unitsJson: choices, shownLpaUnit: lpaUnit)
        return (outcome, stamp())
    }

    /// A lab report's ticked values through the open session, and what saving them did:
    /// one engine door takes the summary against the session's working copy and runs
    /// the import on it in the same step (cloud.ts `cloudLabImport`), so a value another
    /// device brought in is never counted as saved (US-52 AC8).
    func cloudLabImport(extractionJSON: String, refs: [String], reportDay: String, erase: String, units: String, now: Date, choices: String) throws -> (outcome: EditOutcome, order: Int, summary: LabSaveSummary?) {
        let refsJSON = String(decoding: try JSONEncoder().encode(refs), as: UTF8.self)
        let json = try doorCloudLabImport(extractionJson: extractionJSON, refsJson: refsJSON, reportDay: reportDay, erase: erase, shownUnits: units, nowIso: now.formatted(Self.iso), unitsJson: choices)
        let outcome = try JSONDecoder().decode(EditOutcome.self, from: Data(json.utf8))
        return (outcome, stamp(), try JSONDecoder().decode(Summarised.self, from: Data(json.utf8)).summary)
    }

    private struct Summarised: Decodable {
        let summary: LabSaveSummary?
    }

    /// The app came to the foreground: re-read, and retry a refused save.
    func cloudVisible() throws { _ = try doorCloudVisible() }
    /// The app left the screen.
    func cloudHidden() throws { _ = try doorCloudHidden() }

    /// Re-read now; true when something changed.
    func cloudRefresh() async throws -> Bool {
        try await doorCloudRefresh() == "changed"
    }

    /// Save waiting edits now; true when they reached the cloud.
    func cloudFlush() async throws -> Bool {
        try await doorCloudFlush() == "saved"
    }

    /// What `cloudClose` did (ios/engine/cloud.ts): `none`, no open session (an open still in
    /// flight, or none), so nothing to copy (review F6); `closed`, closed without a copy down;
    /// `copied`, the cloud record was merged onto the phone; `unreachable`, the cloud could not be
    /// read for it. A cloud switch stops on `unreachable` and never on `none` (US-25 AC11n).
    enum CloudClose: String {
        case none, closed, copied, unreachable
    }

    /// Close the session. With `copyDown`, merge the cloud record onto the phone first.
    /// An answer this build does not know reads as `unreachable`: no copy is claimed.
    @discardableResult
    func cloudClose(copyDown: Bool) async throws -> CloudClose {
        CloudClose(rawValue: try await doorCloudClose(copyDown: copyDown)) ?? .unreachable
    }

    /// True when an erase made here is still unsent over a failure that may pass (US-25 AC16i,
    /// `cloudEraseHeld`, which flushes first). False for every other answer, a word this build
    /// does not know, and an engine without the door (optionalCall's nil): Disconnect runs as before.
    func eraseHeldOverAPassingFailure() async throws -> Bool {
        try await doorCloudEraseHeld() == "transient"
    }
}
