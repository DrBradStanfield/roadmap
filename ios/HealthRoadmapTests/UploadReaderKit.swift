import Foundation
@testable import HealthRoadmap

/// Test fixtures for the reader's own checks (`LabFileReader.Held`, ZipReader), now that the app
/// reads with health-core's rules only (lead U14, Q4): the rules the app's Swift copy used to answer,
/// kept here as fixed inputs, and a whole-file read through `Held`, as the app's effects run it.
/// Never used by the app.
extension LabFileReader {
    /// The old Swift copy's verdict on a picked file (or a ZIP member once inflated).
    static func swiftVerdict(_ name: String, _ bytes: Int) -> Verdict {
        guard fits(name: name, bytes: bytes) else { return .tooLarge }
        return ["pdf", "jpg", "jpeg", "png", "heic", "zip"].contains(pathExtension(name)) ? .keep : .unsupported
    }

    /// The old Swift copy's verdict on a ZIP member's path.
    static func swiftMemberVerdict(_ path: String) -> Verdict {
        if path.utf8.firstRange(of: Array("__MACOSX".utf8)) != nil || lastComponent(path).first == "." { return .hidden }
        return isReport(path) ? .keep : .unsupported
    }

    /// The web's per-file limit: 20 MB for a ZIP, 10 MB otherwise.
    static func fits(name: String, bytes: Int) -> Bool {
        bytes <= (pathExtension(name) == "zip" ? 20 * 1024 * 1024 : maxFileBytes)
    }

    static let swiftRules: AskRules = { _, _ in .swift }

    /// One picked file read whole into its documents through `Held`: one, or one per kept ZIP member.
    static func documents(from data: Data, name: String, rules: Rules = .swift) async throws -> [Document] {
        guard pathExtension(name) == "zip" else { return [try document(from: data, name: name, rules: rules)] }
        let held = Held()
        held.hold(data, as: name, name: name)
        let members = try held.list(name, rules: rules).filter { rules.member($0.entry.name) == .keep }
        guard !members.isEmpty else { throw Failure.empty }
        return try members.map { try held.convert($0.id, rules: rules) }
    }
}

extension LabFileReader.Rules {
    /// The old Swift copy, as a fixture.
    static let swift = LabFileReader.Rules(file: LabFileReader.swiftVerdict, member: LabFileReader.swiftMemberVerdict,
                                           maxMemberBytes: LabFileReader.maxFileBytes, maxMembers: LabFileReader.maxFolderFiles,
                                           maxTotalBytes: LabFileReader.maxFolderBytes)
}
