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

    /// A lab file in the Dropbox app folder, as the engine lists it (US-52 AC11).
    struct CloudLabFile: Decodable, Equatable, Identifiable, Sendable {
        /// Dropbox's `id:…`, the only way the engine downloads a file.
        let id: String
        let name: String
        let size: Int
        /// Dropbox's `server_modified`, ISO 8601 in UTC.
        let modified: String
        /// The folder it is in, app-folder-relative ("" the root): the engine lists it afresh before a download.
        var folder = ""
        /// Its path below the folder that was listed: its name, or "sub/name" in a whole-folder read.
        var path = ""
    }

    /// A folder in the Dropbox app folder ("" the root), as the engine lists it (US-52 AC13c).
    struct CloudLabFolder: Decodable, Hashable, Sendable {
        let name: String
        let path: String
    }

    /// One folder's subfolders, by name, and its lab files, newest first.
    struct CloudLabListing: Decodable, Equatable, Sendable {
        let folders: [CloudLabFolder]
        let files: [CloudLabFile]
        /// At the root, the app's own folders there, which are not listed.
        var hidden: [String] = []
    }

    /// One folder of the connected Dropbox's app folder. Throws `EngineError.callFailed`
    /// whose text is the failure JSON (`SyncProblem`).
    func labFolder(_ path: String) async throws -> CloudLabListing {
        let json = try await callAsync("labFolderJson", [path])
        return try JSONDecoder().decode(CloudLabListing.self, from: Data(json.utf8))
    }

    /// One listed file: its name in a fresh listing of its folder, which the phone
    /// reads it under (re-check R3), and its bytes. Throws `EngineError.callFailed`
    /// whose text is `{"refused": "…"}` or the failure JSON.
    func labFile(_ file: CloudLabFile) async throws -> (name: String, data: Data) {
        try await callAsync("labFile", [file.id, file.folder]) { answer in
            (answer.forProperty("name")?.toString() ?? file.name, EngineNatives.data(answer.forProperty("bytes")) ?? Data())
        }
    }

    /// Every report in a Dropbox folder and the folders inside it (US-52 AC13c), read as
    /// a folder picked in Files is (`LabFileReader.documents(inFolder:)`): name order, at
    /// most 200 files, each named by its place in the folder; a ZIP gives its members.
    /// Every size is checked on the listing before anything downloads, and the reports'
    /// bytes, ZIP members included, are held to the ZIP reader's 200 MB as they are read.
    /// `maxBytes` is that cap (a test sets a smaller one). `progress(done, total)` before each download. Cancelling stops it before the next
    /// download. Dropbox's refusals and failures throw `DropboxFailure`; a file gone since
    /// the listing, `LabFileReader.Failure.folderChanged`.
    func labFolderDocuments(_ folder: CloudLabFolder, maxBytes: Int = LabFileReader.maxFolderBytes, progress: @MainActor @Sendable (Int, Int) -> Void = { _, _ in }) async throws -> [LabFileReader.Document] {
        let listed: [CloudLabFile]
        do {
            let json = try await callAsync("labFolderFilesJson", [folder.path])
            listed = try JSONDecoder().decode([CloudLabFile].self, from: Data(json.utf8))
        } catch {
            throw DropboxFailure(error)
        }
        let files = listed
            .sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
            .prefix(LabFileReader.maxFolderFiles)
        guard !files.isEmpty else { throw LabFileReader.Failure.folderEmpty }
        if let big = files.first(where: { !LabFileReader.fits(name: $0.name, bytes: $0.size) }) { throw LabFileReader.Failure.tooLarge(big.name) }
        guard files.reduce(0, { $0 + $1.size }) <= maxBytes else { throw LabFileReader.Failure.folderTooLarge }
        let base = folder.path.isEmpty ? "" : folder.name + "/"
        var documents: [LabFileReader.Document] = []
        var bytes = 0
        for (done, file) in files.enumerated() where documents.count < LabFileReader.maxFolderFiles {
            await progress(done, files.count)
            try Task.checkCancellation()
            let fetched: (name: String, data: Data)
            do {
                fetched = try await labFile(file)
            } catch {
                let failure = DropboxFailure(error)
                throw failure.gone ? LabFileReader.Failure.folderChanged : failure
            }
            let read = try LabFileReader.documents(from: fetched.data, name: base + file.path)
            bytes += read.reduce(0) { $0 + ($1.original?.size ?? 0) }
            guard bytes <= maxBytes else { throw LabFileReader.Failure.folderTooLarge }
            documents += read
        }
        return Array(documents.prefix(LabFileReader.maxFolderFiles))
    }
}
