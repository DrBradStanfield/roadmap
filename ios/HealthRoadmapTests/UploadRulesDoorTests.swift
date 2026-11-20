import UIKit
import XCTest
@testable import HealthRoadmap

/// Shared upload PR 3 (US-52 AC7): the reader asks health-core's upload rules through the
/// optional door `uploadVerdictsJson`. With no answer it keeps nothing: the app has no Swift copy
/// of the rules (lead U14). The old copy, now a test fixture (UploadReaderKit), still answers the
/// golden pins as the door does. Synthetic names and bytes only.
final class UploadRulesDoorTests: XCTestCase {
    private typealias Row = [String: Any]
    private typealias File = LabFileReader.UploadFile

    private let png = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { _ in }

    func testTheEngineAnswersThroughTheDoor() throws {
        let engine = try HealthEngine()
        let rules = engine.blocking { $0.uploadRules(files: [File(name: "a.pdf", bytes: 1), File(name: "a.txt", bytes: 1)], members: [".x/a.pdf", "__MACOSX/a.pdf"]) }
        XCTAssertEqual(rules.file("a.pdf", 1), .keep)
        XCTAssertEqual(rules.file("a.txt", 1), .unsupported)
        XCTAssertEqual(rules.member(".x/a.pdf"), .keep)
        XCTAssertEqual(rules.member("__MACOSX/a.pdf"), .hidden)
        XCTAssertEqual(rules.maxMemberBytes, LabFileReader.maxFileBytes)
        XCTAssertEqual(rules.maxMembers, LabFileReader.maxFolderFiles)
        XCTAssertEqual(rules.maxTotalBytes, LabFileReader.maxFolderBytes)
    }

    /// Keeps nothing: every file unsupported, every member hidden, no room in a ZIP.
    private func assertKeepsNothing(_ rules: LabFileReader.Rules, _ what: String, line: UInt = #line) {
        XCTAssertEqual(rules.file("a.pdf", 1), .unsupported, what, line: line)
        XCTAssertEqual(rules.member("a.pdf"), .hidden, what, line: line)
        XCTAssertEqual([rules.maxMemberBytes, rules.maxMembers, rules.maxTotalBytes], [0, 0, 0], what, line: line)
    }

    /// An engine without the door answers nil through optionalCall: the reader keeps nothing.
    func testNoDoorKeepsNothing_US52_AC7() throws {
        let engine = try HealthEngine()
        XCTAssertNil(try engine.blocking { try $0.optionalCall("noSuchOptionalDoor", ["{}"]) })
        let files = [File(name: "a.pdf", bytes: 1)]
        assertKeepsNothing(LabFileReader.Rules(answer: nil, files: files, members: []), "no answer")
        // An answer that does not read, or does not match the question, is no answer.
        assertKeepsNothing(LabFileReader.Rules(answer: "not json", files: files, members: []), "not json")
        assertKeepsNothing(LabFileReader.Rules(answer: #"{"limits":{"fileBytes":1,"zipMembers":1,"folderBytes":1},"files":[],"zipMembers":[]}"#,
                                               files: files, members: []), "not the question asked")
    }

    /// A door answer with a verdict it does not know, or a limit not above 0 or past the app's
    /// ceiling, is no answer: the reader keeps nothing (review R3).
    func testABadDoorAnswerKeepsNothing_US52_AC7() {
        let files = [File(name: "a.pdf", bytes: 1)]
        func answer(verdict: String = "keep", fileBytes: Int = LabFileReader.maxFileBytes, zipMembers: Int = LabFileReader.maxFolderFiles,
                    folderBytes: Int = LabFileReader.maxFolderBytes) -> String {
            #"{"limits":{"fileBytes":\#(fileBytes),"zipMembers":\#(zipMembers),"folderBytes":\#(folderBytes)},"files":["\#(verdict)"],"zipMembers":[]}"#
        }
        // Control: a good answer is the engine's.
        XCTAssertEqual(LabFileReader.Rules(answer: answer(), files: files, members: []).file("a.pdf", 1), .keep)
        for bad in [answer(verdict: "maybe"), answer(fileBytes: 0), answer(fileBytes: LabFileReader.maxFileBytes + 1),
                    answer(zipMembers: -1), answer(zipMembers: LabFileReader.maxFolderFiles + 1),
                    answer(folderBytes: 0), answer(folderBytes: LabFileReader.maxFolderBytes + 1)] {
            assertKeepsNothing(LabFileReader.Rules(answer: bad, files: files, members: []), bad)
        }
    }

    /// A file over its cap by its listed size is never read (US-52 AC7, AC10): it goes to the
    /// engine by its size alone, with no bytes, for the engine to refuse in its own words
    /// (UploadSourcesTests draws that row). This file cannot be read at all, so a read would fail.
    func testAPickedFileOverItsListedSizeGoesUnread_US52_AC7() async throws {
        let engine = try HealthEngine()
        let folder = try Self.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appending(path: "big.pdf")
        FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o200])
        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: UInt64(LabFileReader.maxFileBytes + 1))
        try handle.close()
        let asked = Asked()
        let picked = try await LabFileReader.picked(url) { files, members in
            await asked.add(files, members)
            return await engine.uploadRules(files: files, members: members)
        }
        XCTAssertEqual(picked.map(\.name), ["big.pdf"])
        XCTAssertEqual(picked.map(\.bytes), [LabFileReader.maxFileBytes + 1])
        XCTAssertEqual(picked.map(\.data.count), [0], "nothing read or held")
        let questions = await asked.questions
        XCTAssertEqual(questions.map { $0.files }, [[File(name: "big.pdf", bytes: LabFileReader.maxFileBytes + 1)]], "asked once, by its listed size")
    }

    /// A picked file or ZIP goes whole, as its bytes, by its own name: a ZIP's members are listed
    /// later, by the engine's `list` effect, never here.
    func testAPickedFileOrZipGoesAsItsBytes_US52_AC10() async throws {
        let engine = try HealthEngine()
        let folder = try Self.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let picture = folder.appending(path: "scan.png"), archive = folder.appending(path: "labs.zip")
        try png.write(to: picture)
        let zipped = Self.zip([("a.png", png), ("b.png", png), (".c.png", png)])
        try zipped.write(to: archive)
        for (url, bytes) in [(picture, png), (archive, zipped)] {
            let picked = try await LabFileReader.picked(url) { await engine.uploadRules(files: $0, members: $1) }
            XCTAssertEqual(picked.map(\.name), [url.lastPathComponent])
            XCTAssertEqual(picked.first?.data, bytes)
        }
    }

    /// A ZIP is read by the rules it is given, not the reader's own: the engine's keep its
    /// reports and drop the dot file; rules that keep no member read none.
    func testAZipIsReadByTheRulesItIsGiven() async throws {
        let engine = try HealthEngine()
        let zip = Self.zip([("a.png", png), ("b.png", png), (".c.png", png)])
        // Asked as the runner asks: the ZIP, each member as the file it is read as, and the paths.
        let paths = ["a.png", "b.png", ".c.png"]
        let rules = await engine.uploadRules(files: [File(name: "labs.zip", bytes: zip.count)] + paths.map { File(name: "labs.zip/\($0)", bytes: png.count) },
                                             members: paths)
        let read = try await LabFileReader.documents(from: zip, name: "labs.zip", rules: rules)
        XCTAssertEqual(read.map(\.name), ["labs.zip/a.png", "labs.zip/b.png"])
        let refuseAll = LabFileReader.Rules(file: { _, _ in .keep }, member: { _ in .hidden },
                                            maxMemberBytes: 1 << 20, maxMembers: 10, maxTotalBytes: 1 << 20)
        await XCTAssertThrowsErrorAsync(try await LabFileReader.documents(from: zip, name: "labs.zip", rules: refuseAll))
    }

    /// The door and the old Swift copy (a fixture now) agree on every pinned row (the pins:
    /// upload-decisions.json), so the reader tests that use the fixture read as the app does.
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
