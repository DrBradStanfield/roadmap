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
    /// Throws `EngineError.callFailed` whose text is the failure's JSON (`SyncProblem`).
    func cloudOpen(provider: CloudProvider, deviceId: String, firstConnect: Bool) async throws -> CloudView {
        let (json, order) = try await callAsync("cloudOpen", [provider.rawValue, deviceId, firstConnect], read: stamped)
        var view = try JSONDecoder().decode(CloudView.self, from: Data(json.utf8))
        view.order = order
        natives.openSession = (view.session, view.record)
        return view
    }

    /// One My data edit through the open session, checked against the erase and the
    /// units the screen showed when the edit began (a sheet's opening).
    /// `choices`: the per-test units the sheet showed (US-25 AC17e), as JSON.
    func cloudEdit(_ edit: RecordEdit, erase: String, units: String, now: Date, choices: String = "{}") throws -> EditOutcome {
        let editJSON = String(decoding: try JSONEncoder().encode(edit), as: UTF8.self)
        let json = try call("cloudEdit", [editJSON, erase, units, now.formatted(Self.iso), choices])
        var outcome = try JSONDecoder().decode(EditOutcome.self, from: Data(json.utf8))
        outcome.order = stamp()
        if outcome.ok, let record = outcome.record, let id = natives.openSession?.id { natives.openSession = (id, record) }
        return outcome
    }

    /// A lab report's ticked values through the open session, and what saving them did,
    /// in one engine step: the summary is taken against the session's working copy the
    /// import lands on, so a value another device brought in is never counted as saved.
    func cloudLabImport(extractionJSON: String, refs: [String], reportDay: String, erase: String, units: String, now: Date, choices: String, deviceId: String) throws -> (summary: Result<LabSaveSummary, LabRefusal>, outcome: EditOutcome?) {
        guard let record = natives.openSession?.record else { return (.failure(LabRefusal(message: "That could not be saved.")), nil) }
        let summary = try labSaveSummary(recordJSON: record, extractionJSON: extractionJSON, refs: refs, reportDay: reportDay, now: now, deviceId: deviceId)
        guard case .success = summary else { return (summary, nil) }
        let edit = RecordEdit.labImport(extractionJSON: extractionJSON, refs: refs, reportDay: reportDay)
        return (summary, try cloudEdit(edit, erase: erase, units: units, now: now, choices: choices))
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
        natives.openSession = nil
        return try await callAsync("cloudClose", [copyDown]) == "copied"
    }

    /// A lab file in the Dropbox app folder, as the engine lists it (US-52 AC11).
    struct CloudLabFile: Decodable, Equatable, Identifiable, Sendable {
        /// Dropbox's `id:…`, the only way the engine downloads a file.
        let id: String
        let name: String
        let size: Int
        /// Dropbox's `server_modified`, ISO 8601 in UTC.
        let modified: String
    }

    /// The lab files in the connected Dropbox's app folder, newest first. Throws
    /// `EngineError.callFailed` whose text is the failure JSON (`SyncProblem`).
    func labFiles() async throws -> [CloudLabFile] {
        let json = try await callAsync("labFilesJson", [])
        return try JSONDecoder().decode([CloudLabFile].self, from: Data(json.utf8))
    }

    /// One listed file: its name in a fresh listing, which the phone reads it
    /// under (re-check R3), and its bytes. Throws `EngineError.callFailed` whose
    /// text is `{"refused": "…"}` or the failure JSON.
    func labFile(_ file: CloudLabFile) async throws -> (name: String, data: Data) {
        try await callAsync("labFile", [file.id]) { answer in
            (answer.forProperty("name")?.toString() ?? file.name, EngineNatives.data(answer.forProperty("bytes")) ?? Data())
        }
    }
}
