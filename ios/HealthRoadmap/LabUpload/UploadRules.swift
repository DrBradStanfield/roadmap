import Foundation

extension LabFileReader {
    /// One file to judge: its name as read and its size.
    struct UploadFile: Encodable, Hashable, Sendable {
        let name: String
        let bytes: Int
    }

    /// health-core's FileVerdict (upload-rules.ts).
    enum Verdict: String, Decodable, Sendable {
        case keep, tooLarge, unsupported, hidden
    }

    /// The rules a pick is read with (US-52 AC7): health-core's (upload-rules.ts), answered by the
    /// optional door `uploadVerdictsJson` for exactly the files and ZIP members asked. The shared
    /// upload runs only on an engine that has it (`runsSharedUpload`); an answer that cannot be read
    /// keeps nothing (`none`), never a Swift copy of the rules (lead U14).
    struct Rules: Sendable {
        /// A file's verdict by its name and size.
        let file: @Sendable (_ name: String, _ bytes: Int) -> Verdict
        /// A ZIP member's verdict by its path.
        let member: @Sendable (_ path: String) -> Verdict
        /// A ZIP's caps: one member once inflated, members kept, bytes kept in all.
        let maxMemberBytes: Int
        let maxMembers: Int
        let maxTotalBytes: Int

        /// Keeps nothing: every file unsupported, every member hidden, no room in a ZIP.
        static let none = Rules(file: { _, _ in .unsupported }, member: { _ in .hidden }, maxMemberBytes: 0, maxMembers: 0, maxTotalBytes: 0)

        /// The engine's answer to `files` and `members`, or `none` when there is none, it cannot be
        /// read, or a limit in it is not above 0 and at most the app's own ceiling. Names are matched
        /// by their Unicode scalars, as the engine reads them. A file or member not asked keeps
        /// nothing: never expected, since each read asks for what it then checks.
        init(answer: String?, files: [UploadFile], members: [String]) {
            struct Answer: Decodable {
                struct Limits: Decodable { let fileBytes: Int; let zipMembers: Int; let folderBytes: Int }
                let limits: Limits
                let files: [Verdict]
                let zipMembers: [Verdict]
            }
            guard let answer, let read = try? JSONDecoder().decode(Answer.self, from: Data(answer.utf8)),
                  read.files.count == files.count, read.zipMembers.count == members.count,
                  (1...maxFileBytes).contains(read.limits.fileBytes), (1...maxFolderFiles).contains(read.limits.zipMembers),
                  (1...maxFolderBytes).contains(read.limits.folderBytes)
            else { self = .none; return }
            let scalars: @Sendable (String) -> [UInt32] = { $0.unicodeScalars.map(\.value) }
            struct Key: Hashable { let name: [UInt32]; let bytes: Int }
            let fileVerdicts = Dictionary(zip(files.map { Key(name: scalars($0.name), bytes: $0.bytes) }, read.files), uniquingKeysWith: { first, _ in first })
            let memberVerdicts = Dictionary(zip(members.map(scalars), read.zipMembers), uniquingKeysWith: { first, _ in first })
            self.init(file: { name, bytes in fileVerdicts[Key(name: scalars(name), bytes: bytes)] ?? .unsupported },
                      member: { path in memberVerdicts[scalars(path)] ?? .hidden },
                      maxMemberBytes: read.limits.fileBytes, maxMembers: read.limits.zipMembers, maxTotalBytes: read.limits.folderBytes)
        }

        init(file: @escaping @Sendable (String, Int) -> Verdict, member: @escaping @Sendable (String) -> Verdict,
             maxMemberBytes: Int, maxMembers: Int, maxTotalBytes: Int) {
            self.file = file
            self.member = member
            self.maxMemberBytes = maxMemberBytes
            self.maxMembers = maxMembers
            self.maxTotalBytes = maxTotalBytes
        }
    }

    /// Asks the rules for one step of a read: the files it will check and a ZIP's member paths.
    typealias AskRules = @Sendable (_ files: [UploadFile], _ members: [String]) async -> Rules

    /// A path's last component, after its last "/", by Unicode scalar as health-core reads it
    /// (a combining mark never hides a "/" or a leading ".").
    static func lastComponent(_ path: String) -> Substring.UnicodeScalarView {
        let scalars = Substring(path).unicodeScalars
        return scalars.lastIndex(of: "/").map { scalars[scalars.index(after: $0)...] } ?? scalars
    }

    /// A path's extension, lowercased, as health-core's extensionOf reads it: after the last
    /// component's last ".", '' when there is none or it is the first scalar.
    static func pathExtension(_ path: String) -> String {
        let last = lastComponent(path)
        guard let dot = last.lastIndex(of: "."), dot != last.startIndex else { return "" }
        return String(last[last.index(after: dot)...]).lowercased()
    }
}

extension HealthEngine {
    /// health-core's upload rules for one step of a read (the optional door `uploadVerdictsJson`);
    /// `none` from an engine without the door, or when the call fails.
    func uploadRules(files: [LabFileReader.UploadFile], members: [String]) -> LabFileReader.Rules {
        struct Request: Encodable { let files: [LabFileReader.UploadFile]; let zipMembers: [String] }
        let request = (try? JSONEncoder().encode(Request(files: files, zipMembers: members))).map { String(decoding: $0, as: UTF8.self) }
        let answer = request.flatMap { try? doorUploadVerdictsJson(request: $0) }
        return LabFileReader.Rules(answer: answer, files: files, members: members)
    }
}
