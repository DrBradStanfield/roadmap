import Foundation

/// The engine doors "Add medical records" uses (US-52). Each runs health-core in
/// JavaScriptCore; these only carry text and bytes across.
extension HealthEngine {
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
            let read = try await LabFileReader.decoded(fetched.data, name: base + file.path)
            bytes += read.reduce(0) { $0 + ($1.original?.size ?? 0) }
            guard bytes <= maxBytes else { throw LabFileReader.Failure.folderTooLarge }
            documents += read
        }
        return Array(documents.prefix(LabFileReader.maxFolderFiles))
    }

    /// The review of the server's extraction (the `data` object, as JSON text). With the
    /// record, the file's name and the original's hash, a document says whether it is
    /// already saved and whether a held row stands for it (AC13d, US-14 AC4).
    func labReview(extractionJSON: String, now: Date, recordJSON: String = "", sourceFileName: String = "", contentHash: String = "", deviceId: String = "") throws -> LabReview {
        let json = try call("labReviewJson", [extractionJSON, now.formatted(Self.iso), recordJSON, sourceFileName, contentHash, deviceId])
        return try JSONDecoder().decode(LabReview.self, from: Data(json.utf8))
    }

    /// Each file read, named as health-core stores a `sourceFileName` (the document dedup
    /// key, AC13d): a ZIP member by the web's zipMemberName, any other file on one line and
    /// cut to its cap. One engine call per read; on a failure the names stay as read.
    func named(_ documents: [LabFileReader.Document]) async -> [LabFileReader.Document] {
        let files: [[String: String]] = documents.map { document in
            document.zipMember.map { ["zip": $0.zip, "path": $0.path] } ?? ["name": document.name]
        }
        guard let json = try? JSONEncoder().encode(files),
              let answer = try? await callAsync("fileNamesJson", [String(decoding: json, as: UTF8.self)]),
              let names = try? JSONDecoder().decode([String].self, from: Data(answer.utf8)), names.count == documents.count
        else { return documents }
        var named = documents
        for index in named.indices { named[index].name = names[index] }
        return named
    }

    /// Files one document, or a lab report's original, through health-core's saveDocuments
    /// (US-52 AC13d). `erase`: the cloud record's, or "" for the phone's file `recordJSON`.
    func documentSave(recordJSON: String, extractionJSON: String, choice: DocumentChoice, original: Data?, erase: String, now: Date, deviceId: String) async throws -> DocumentSaveAnswer {
        let choiceJSON = String(decoding: try JSONEncoder().encode(choice), as: UTF8.self)
        let bytes: Any = original.map { arrayBuffer($0) } ?? NSNull()
        let (json, order) = try await callAsync("documentSave", [recordJSON, extractionJSON, choiceJSON, bytes, erase, now.formatted(Self.iso), deviceId], read: stamped)
        var answer = try JSONDecoder().decode(DocumentSaveAnswer.self, from: Data(json.utf8))
        answer.order = order
        return answer
    }

    /// What saving `refs` on `reportDay` would do, or the engine's refusal. The record is not changed.
    func labSaveSummary(recordJSON: String, extractionJSON: String, refs: [String], reportDay: String, now: Date, deviceId: String) throws -> Result<LabSaveSummary, LabRefusal> {
        let refsJSON = String(decoding: try JSONEncoder().encode(refs), as: UTF8.self)
        let json = try call("labSaveSummaryJson", [recordJSON, extractionJSON, refsJSON, reportDay, now.formatted(Self.iso), deviceId])
        let answer = try JSONDecoder().decode(SummaryAnswer.self, from: Data(json.utf8))
        if answer.ok, let summary = answer.summary { return .success(summary) }
        return .failure(LabRefusal(message: answer.message ?? "These values could not be saved."))
    }
}

private struct SummaryAnswer: Decodable {
    let ok: Bool
    let summary: LabSaveSummary?
    let message: String?
}
