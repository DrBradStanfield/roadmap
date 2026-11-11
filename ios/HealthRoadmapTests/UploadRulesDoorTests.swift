import UIKit
import XCTest
@testable import HealthRoadmap

/// Shared upload PR 3 (US-52 AC7): the reader asks health-core's upload rules through the
/// optional door `uploadVerdictsJson` when the engine has it, and keeps its Swift copy when
/// it does not (an older engine; lead U14). Both answer the golden pins the same.
/// Synthetic names and bytes only.
final class UploadRulesDoorTests: XCTestCase {
    private typealias Row = [String: Any]
    private typealias File = LabFileReader.UploadFile

    private let png = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { _ in }

    func testTheEngineAnswersThroughTheDoor() throws {
        let engine = try HealthEngine()
        let rules = engine.blocking { $0.uploadRules(files: [File(name: "a.pdf", bytes: 1), File(name: "a.txt", bytes: 1)], members: [".x/a.pdf", "__MACOSX/a.pdf"]) }
        XCTAssertEqual(rules.source, .engine)
        XCTAssertEqual(rules.file("a.pdf", 1), "keep")
        XCTAssertEqual(rules.file("a.txt", 1), "unsupported")
        XCTAssertEqual(rules.member(".x/a.pdf"), "keep")
        XCTAssertEqual(rules.member("__MACOSX/a.pdf"), "hidden")
        XCTAssertEqual(rules.maxMemberBytes, LabFileReader.maxFileBytes)
        XCTAssertEqual(rules.maxMembers, LabFileReader.maxFolderFiles)
        XCTAssertEqual(rules.maxTotalBytes, LabFileReader.maxFolderBytes)
    }

    /// An engine without the door answers nil through optionalCall: the reader keeps the Swift copy.
    func testNoDoorKeepsTheSwiftRules() throws {
        let engine = try HealthEngine()
        XCTAssertNil(try engine.blocking { try $0.optionalCall("noSuchOptionalDoor", ["{}"]) })
        let files = [File(name: "a.pdf", bytes: 1)]
        XCTAssertEqual(LabFileReader.Rules(answer: nil, files: files, members: []).source, .swift)
        // An answer that does not read, or does not match the question, is no answer.
        XCTAssertEqual(LabFileReader.Rules(answer: "not json", files: files, members: []).source, .swift)
        XCTAssertEqual(LabFileReader.Rules(answer: #"{"limits":{"fileBytes":1,"zipMembers":1,"folderBytes":1},"files":[],"zipMembers":[]}"#,
                                           files: files, members: []).source, .swift)
    }

    /// A picked ZIP asks twice (its listed size, then its bytes and members) and reads by the answer.
    func testAPickedZipIsReadByTheRulesItIsAsked() async throws {
        let engine = try HealthEngine()
        let folder = FileManager.default.temporaryDirectory.appending(path: "Upload rules \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appending(path: "labs.zip")
        try Self.zip([("a.png", png), ("b.png", png), (".c.png", png)]).write(to: url)

        let asked = Asked()
        let read = try await LabFileReader.documents(picked: url) { files, members in
            await asked.add(files, members)
            return await engine.uploadRules(files: files, members: members)
        }
        XCTAssertEqual(read.map(\.name), ["labs.zip/a.png", "labs.zip/b.png"])
        let questions = await asked.questions
        XCTAssertEqual(questions.count, 2)
        XCTAssertEqual(questions.last?.members, ["a.png", "b.png", ".c.png"])
        XCTAssertEqual(questions.last?.files.map(\.name), ["labs.zip", "labs.zip/a.png", "labs.zip/b.png", "labs.zip/.c.png"])

        // The reader follows the rules it is given, not its own: rules that keep no member read none.
        let refuseAll = LabFileReader.Rules(source: .engine, file: { _, _ in "keep" }, member: { _ in "hidden" },
                                            maxMemberBytes: 1 << 20, maxMembers: 10, maxTotalBytes: 1 << 20)
        await XCTAssertThrowsErrorAsync(try await LabFileReader.documents(picked: url) { _, _ in refuseAll })
    }

    /// The door and the Swift copy agree on every pinned row (the pins: upload-decisions.json).
    func testTheDoorAndTheSwiftCopyAgreeOnEveryPin() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "upload-decisions", withExtension: "json"))
        let table = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? Row)
        func rows(_ section: String) -> [Row] { (table[section] as? Row)?["rows"] as? [Row] ?? [] }
        let files = rows("fileSizes").compactMap { row in (row["name"] as? String).map { File(name: $0, bytes: row["bytes"] as? Int ?? 0) } }
            + rows("fileKinds").compactMap { ($0["name"] as? String).map { File(name: $0, bytes: 1) } }
        let members = rows("zipMembers").compactMap { $0["path"] as? String }
        XCTAssertFalse(files.isEmpty || members.isEmpty)

        let engine = try HealthEngine()
        let rules = engine.blocking { $0.uploadRules(files: files, members: members) }
        XCTAssertEqual(rules.source, .engine)
        for file in files { XCTAssertEqual(rules.file(file.name, file.bytes), LabFileReader.swiftVerdict(file.name, file.bytes), "\(file)") }
        for path in members { XCTAssertEqual(rules.member(path) == "keep", LabFileReader.swiftMemberVerdict(path) == "keep", path) }
    }

    private actor Asked {
        var questions: [(files: [File], members: [String])] = []
        func add(_ files: [File], _ members: [String]) { questions.append((files, members)) }
    }

    private func XCTAssertThrowsErrorAsync<T>(_ call: @autoclosure () async throws -> T, line: UInt = #line) async {
        do { _ = try await call(); XCTFail("did not throw", line: line) } catch {}
    }

    /// A minimal ZIP of stored members, with a central directory.
    private static func zip(_ members: [(String, Data)]) -> Data {
        var out = Data()
        var central = Data()
        func u16(_ v: Int) -> Data { withUnsafeBytes(of: UInt16(v).littleEndian) { Data($0) } }
        func u32(_ v: Int) -> Data { withUnsafeBytes(of: UInt32(v).littleEndian) { Data($0) } }
        for (name, data) in members {
            let offset = out.count
            let header = u16(20) + u16(0) + u16(0) + u16(0) + u16(0) + u32(0) + u32(data.count) + u32(data.count) + u16(name.utf8.count) + u16(0)
            out += u32(0x0403_4b50) + header + Data(name.utf8) + data
            central += u32(0x0201_4b50) + u16(20) + header + u16(0) + u16(0) + u16(0) + u32(0) + u32(offset) + Data(name.utf8)
        }
        let start = out.count
        out += central
        out += u32(0x0605_4b50) + u16(0) + u16(0) + u16(members.count) + u16(members.count) + u32(central.count) + u32(start) + u16(0)
        return out
    }
}
