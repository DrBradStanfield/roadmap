import Foundation

/// The engine's cloud doors (ios/engine/cloud.ts, US-25 AC11). The sync itself,
/// save loop, merge and erase guard included, is health-core's, in JavaScript;
/// these only carry text across.
extension HealthEngine {
    /// The record and the erase it is at, as the engine hands them over.
    struct CloudView: Decodable, Equatable {
        let record: String
        let erase: String
    }

    /// Open the cloud record. `firstConnect` merges the phone's record up first.
    /// Throws `EngineError.callFailed` whose text is the failure's JSON (`SyncProblem`).
    @MainActor
    func cloudOpen(provider: CloudProvider, deviceId: String, firstConnect: Bool) async throws -> CloudView {
        let json = try await callAsync("cloudOpen", [provider.rawValue, deviceId, firstConnect])
        return try JSONDecoder().decode(CloudView.self, from: Data(json.utf8))
    }

    /// One My data edit through the open session, checked against the erase the screen showed.
    func cloudEdit(_ edit: RecordEdit, erase: String, now: Date) throws -> EditOutcome {
        let editJSON = String(decoding: try JSONEncoder().encode(edit), as: UTF8.self)
        let json = try call("cloudEdit", [editJSON, erase, now.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))])
        return try JSONDecoder().decode(EditOutcome.self, from: Data(json.utf8))
    }

    /// The app came to the foreground: re-read, and retry a refused save.
    func cloudVisible() throws { _ = try call("cloudVisible", []) }
    /// The app left the screen.
    func cloudHidden() throws { _ = try call("cloudHidden", []) }

    /// Re-read now; true when something changed.
    @MainActor
    func cloudRefresh() async throws -> Bool {
        try await callAsync("cloudRefresh", []) == "changed"
    }

    /// Save waiting edits now; true when they reached the cloud.
    @MainActor
    func cloudFlush() async throws -> Bool {
        try await callAsync("cloudFlush", []) == "saved"
    }

    /// Close the session. With `copyDown`, merge the cloud record onto the phone
    /// first; false when the cloud could not be read for that.
    @MainActor
    @discardableResult
    func cloudClose(copyDown: Bool) async throws -> Bool {
        try await callAsync("cloudClose", [copyDown]) != "unreachable"
    }
}
