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
        let (json, order) = try await callAsync("cloudOpen", [provider.rawValue, deviceId, firstConnect, mergePhone], read: stamped)
        var view = try JSONDecoder().decode(CloudView.self, from: Data(json.utf8))
        view.order = order
        return view
    }

    /// One My data edit through the open session, checked against the erase and the
    /// units the screen showed when the edit began (a sheet's opening).
    /// `choices`: the per-test units the sheet showed (US-25 AC17e), as JSON.
    func cloudEdit(_ edit: RecordEdit, erase: String, units: String, now: Date, choices: String = "{}", lpaUnit: String) throws -> EditOutcome {
        let editJSON = String(decoding: try JSONEncoder().encode(edit), as: UTF8.self)
        let json = try call("cloudEdit", [editJSON, erase, units, now.formatted(Self.iso), choices, lpaUnit])
        var outcome = try JSONDecoder().decode(EditOutcome.self, from: Data(json.utf8))
        outcome.order = stamp()
        return outcome
    }

    /// A lab report's ticked values through the open session, and what saving them did:
    /// one engine door takes the summary against the session's working copy and runs
    /// the import on it in the same step (cloud.ts `cloudLabImport`), so a value another
    /// device brought in is never counted as saved (US-52 AC8).
    func cloudLabImport(extractionJSON: String, refs: [String], reportDay: String, erase: String, units: String, now: Date, choices: String) throws -> (outcome: EditOutcome, summary: LabSaveSummary?) {
        let refsJSON = String(decoding: try JSONEncoder().encode(refs), as: UTF8.self)
        let json = try call("cloudLabImport", [extractionJSON, refsJSON, reportDay, erase, units, now.formatted(Self.iso), choices])
        var outcome = try JSONDecoder().decode(EditOutcome.self, from: Data(json.utf8))
        outcome.order = stamp()
        return (outcome, try JSONDecoder().decode(Summarised.self, from: Data(json.utf8)).summary)
    }

    private struct Summarised: Decodable {
        let summary: LabSaveSummary?
    }

    /// The app came to the foreground: re-read, and retry a refused save.
    func cloudVisible() throws { _ = try call("cloudVisible", []) }
    /// The app left the screen.
    func cloudHidden() throws { _ = try call("cloudHidden", []) }

    /// Re-read now; true when something changed.
    func cloudRefresh() async throws -> Bool {
        try await callAsync("cloudRefresh", []) == "changed"
    }

    /// Save waiting edits now; true when they reached the cloud.
    func cloudFlush() async throws -> Bool {
        try await callAsync("cloudFlush", []) == "saved"
    }

    /// Close the session. With `copyDown`, merge the cloud record onto the phone
    /// first; true only when that copy happened. No open session (an open still in
    /// flight, or none) copies nothing, and says so (review F6).
    @discardableResult
    func cloudClose(copyDown: Bool) async throws -> Bool {
        try await callAsync("cloudClose", [copyDown]) == "copied"
    }
}
