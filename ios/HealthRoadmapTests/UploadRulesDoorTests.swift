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
        XCTAssertEqual(rules.file("a.pdf", 1), .keep)
        XCTAssertEqual(rules.file("a.txt", 1), .unsupported)
        XCTAssertEqual(rules.member(".x/a.pdf"), .keep)
        XCTAssertEqual(rules.member("__MACOSX/a.pdf"), .hidden)
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

    /// A door answer with a verdict it does not know, or a limit not above 0 or past the Swift
    /// copy's, is no answer: the reader keeps the Swift rules (review R3).
    func testABadDoorAnswerKeepsTheSwiftRules() {
        let files = [File(name: "a.pdf", bytes: 1)]
        func answer(verdict: String = "keep", fileBytes: Int = LabFileReader.maxFileBytes, zipMembers: Int = LabFileReader.maxFolderFiles,
                    folderBytes: Int = LabFileReader.maxFolderBytes) -> String {
            #"{"limits":{"fileBytes":\#(fileBytes),"zipMembers":\#(zipMembers),"folderBytes":\#(folderBytes)},"files":["\#(verdict)"],"zipMembers":[]}"#
        }
        // Control: a good answer is the engine's.
        XCTAssertEqual(LabFileReader.Rules(answer: answer(), files: files, members: []).source, .engine)
        for bad in [answer(verdict: "maybe"), answer(fileBytes: 0), answer(fileBytes: LabFileReader.maxFileBytes + 1),
                    answer(zipMembers: -1), answer(zipMembers: LabFileReader.maxFolderFiles + 1),
                    answer(folderBytes: 0), answer(folderBytes: LabFileReader.maxFolderBytes + 1)] {
            let rules = LabFileReader.Rules(answer: bad, files: files, members: [])
            XCTAssertEqual(rules.source, .swift, bad)
            XCTAssertEqual(rules.maxMemberBytes, LabFileReader.maxFileBytes, bad)
        }
    }

    /// The production path refuses a file over its cap by its listed size, before reading it.
    func testAPickedFileOverItsListedSizeIsRefusedUnread() async throws {
        let engine = try HealthEngine()
        let folder = try Self.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appending(path: "big.pdf")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: UInt64(LabFileReader.maxFileBytes + 1))
        try handle.close()
        let asked = Asked()
        do {
            _ = try await LabFileReader.documents(picked: url) { files, members in
                await asked.add(files, members)
                return await engine.uploadRules(files: files, members: members)
            }
            XCTFail("not refused")
        } catch {
            XCTAssertEqual(error.localizedDescription, LabFileReader.Failure.tooLarge("big.pdf").localizedDescription)
        }
        let questions = await asked.questions
        XCTAssertEqual(questions.map { $0.files }, [[File(name: "big.pdf", bytes: LabFileReader.maxFileBytes + 1)]], "asked once, by its listed size")
    }

    /// A picked file's original is kept as the file itself, opened again at save (keptAsFile).
    func testAPickedFileKeepsItsOriginalAsTheFile() async throws {
        let engine = try HealthEngine()
        let folder = try Self.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appending(path: "scan.png")
        try png.write(to: url)
        let read = try await LabFileReader.documents(picked: url) { await engine.uploadRules(files: $0, members: $1) }
        let original = try XCTUnwrap(read.first?.original)
        guard case .file(let file, let scope) = original.source else { return XCTFail("kept as bytes, not the file") }
        XCTAssertEqual(file, url)
        XCTAssertEqual(scope, url)
        XCTAssertEqual(original.size, png.count)
        XCTAssertEqual(original.verifiedData(), png)
    }

    /// A picked ZIP asks twice (its listed size, then its bytes and members) and reads by the answer.
    func testAPickedZipIsReadByTheRulesItIsAsked() async throws {
        let engine = try HealthEngine()
        let folder = try Self.folder()
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
        let refuseAll = LabFileReader.Rules(source: .engine, file: { _, _ in .keep }, member: { _ in .hidden },
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
            // Review R1: a combining mark after "." or in "__MACOSX", and a name of two dots and "zip".
            + [File(name: "..zip", bytes: 15 * 1024 * 1024), File(name: ".\u{301}a.pdf", bytes: 1), File(name: "d/.\u{301}a.pdf", bytes: 1)]
        let members = rows("zipMembers").compactMap { $0["path"] as? String } + [".\u{301}a.pdf", "d/.\u{301}a.pdf", "__MACOSX\u{301}/a.pdf"]
        XCTAssertFalse(files.isEmpty || members.isEmpty)

        let engine = try HealthEngine()
        let rules = engine.blocking { $0.uploadRules(files: files, members: members) }
        XCTAssertEqual(rules.source, .engine)
        for file in files { XCTAssertEqual(rules.file(file.name, file.bytes), LabFileReader.swiftVerdict(file.name, file.bytes), "\(file)") }
        for path in members { XCTAssertEqual(rules.member(path), LabFileReader.swiftMemberVerdict(path), path) }
    }

    private static func folder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Upload rules \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
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
