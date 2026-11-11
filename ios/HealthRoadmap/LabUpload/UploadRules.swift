import Foundation

extension LabFileReader {
    /// One file to judge: its name as read and its size.
    struct UploadFile: Encodable, Hashable, Sendable {
        let name: String
        let bytes: Int
    }

    /// The rules a pick is read with (US-52 AC7): health-core's (upload-rules.ts), answered by the
    /// optional door `uploadVerdictsJson` for exactly the files and ZIP members asked, or this
    /// file's Swift copy for an engine without the door (lead U14 deletes the copy once the
    /// engine floor guarantees the door). Today both answer the same (the golden pins).
    struct Rules: Sendable {
        enum Source: Sendable { case engine, swift }
        let source: Source
        /// A file's verdict by its name and size: "keep", "tooLarge", "unsupported" or "hidden".
        let file: @Sendable (_ name: String, _ bytes: Int) -> String
        /// A ZIP member's verdict by its path.
        let member: @Sendable (_ path: String) -> String
        /// A ZIP's caps: one member once inflated, members kept, bytes kept in all.
        let maxMemberBytes: Int
        let maxMembers: Int
        let maxTotalBytes: Int

        /// The Swift copy: LabFileReader's own limits and rules.
        static let swift = Rules(source: .swift, file: LabFileReader.swiftVerdict, member: LabFileReader.swiftMemberVerdict,
                                 maxMemberBytes: maxFileBytes, maxMembers: maxFolderFiles, maxTotalBytes: maxFolderBytes)

        /// The engine's answer to `files` and `members`, or the Swift copy when there is none (an
        /// engine without the door) or it cannot be read. A file or member not asked is judged by
        /// the Swift copy too: never expected, since each read asks for what it then checks.
        init(answer: String?, files: [UploadFile], members: [String]) {
            struct Answer: Decodable {
                struct Limits: Decodable { let fileBytes: Int; let zipMembers: Int; let folderBytes: Int }
                let limits: Limits
                let files: [String]
                let zipMembers: [String]
            }
            guard let answer, let read = try? JSONDecoder().decode(Answer.self, from: Data(answer.utf8)),
                  read.files.count == files.count, read.zipMembers.count == members.count
            else { self = .swift; return }
            let fileVerdicts = Dictionary(zip(files, read.files), uniquingKeysWith: { first, _ in first })
            let memberVerdicts = Dictionary(zip(members, read.zipMembers), uniquingKeysWith: { first, _ in first })
            self.init(source: .engine,
                      file: { name, bytes in fileVerdicts[UploadFile(name: name, bytes: bytes)] ?? LabFileReader.swiftVerdict(name, bytes) },
                      member: { path in memberVerdicts[path] ?? LabFileReader.swiftMemberVerdict(path) },
                      maxMemberBytes: read.limits.fileBytes, maxMembers: read.limits.zipMembers, maxTotalBytes: read.limits.folderBytes)
        }

        init(source: Source, file: @escaping @Sendable (String, Int) -> String, member: @escaping @Sendable (String) -> String,
             maxMemberBytes: Int, maxMembers: Int, maxTotalBytes: Int) {
            self.source = source
            self.file = file
            self.member = member
            self.maxMemberBytes = maxMemberBytes
            self.maxMembers = maxMembers
            self.maxTotalBytes = maxTotalBytes
        }
    }

    /// Asks the rules for one step of a read: the files it will check and a ZIP's member paths.
    typealias AskRules = @Sendable (_ files: [UploadFile], _ members: [String]) async -> Rules

    /// The Swift copy's verdict on a picked file (or a ZIP member once inflated).
    static func swiftVerdict(_ name: String, _ bytes: Int) -> String {
        guard fits(name: name, bytes: bytes) else { return "tooLarge" }
        return ["pdf", "jpg", "jpeg", "png", "heic", "zip"].contains((name as NSString).pathExtension.lowercased()) ? "keep" : "unsupported"
    }

    /// The Swift copy's verdict on a ZIP member's path.
    static func swiftMemberVerdict(_ path: String) -> String {
        if path.contains("__MACOSX") || (path as NSString).lastPathComponent.hasPrefix(".") { return "hidden" }
        return isReport(path) ? "keep" : "unsupported"
    }
}

extension HealthEngine {
    /// health-core's upload rules for one step of a read (the optional door `uploadVerdictsJson`);
    /// the Swift copy from an engine without the door, or when the call fails.
    func uploadRules(files: [LabFileReader.UploadFile], members: [String]) -> LabFileReader.Rules {
        struct Request: Encodable { let files: [LabFileReader.UploadFile]; let zipMembers: [String] }
        let request = (try? JSONEncoder().encode(Request(files: files, zipMembers: members))).map { String(decoding: $0, as: UTF8.self) }
        let answer = request.flatMap { try? optionalCall("uploadVerdictsJson", [$0]) }
        return LabFileReader.Rules(answer: answer, files: files, members: members)
    }
}
