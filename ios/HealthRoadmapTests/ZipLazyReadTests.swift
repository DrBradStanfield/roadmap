import Compression
import CryptoKit
import UIKit
import XCTest
@testable import HealthRoadmap

/// US-52 AC7f: a ZIP is listed from its central directory before any member is read, and each
/// file or member is hashed and converted on demand. Synthetic fixtures only.
final class ZipLazyReadTests: XCTestCase {
    // MARK: refusals, pinned on the read-all reader before the lazy one replaced it

    /// One row per refusal the reader made before AC7f, through the old entry point: each ZIP
    /// fails or reads exactly as it did. Single faults only: with two faults in one ZIP, a size
    /// or format fault the central directory shows is now named before an earlier member's bad bytes.
    func testLimitsAndRefusalsAreUnchanged() async throws {
        let png = Self.png, small = Self.caps(member: 100_000, members: 200, total: 1_000_000)
        let rows: [(String, Data, LabFileReader.Rules, String)] = [
            ("two good members", Self.zip([.init("a.png", png), .init("b.png", png, deflate: true)]), .swift, "read 2"),
            ("not a zip", Data("not a zip".utf8), .swift, "notAZip"),
            ("under 22 bytes", Data(count: 21), .swift, "notAZip"),
            ("encrypted", Self.zip([.init("a.png", png, flags: 1)]), .swift, "unsupported"),
            ("ZIP64 sizes", Self.zip([.init("a.png", png, compressed: 0xFFFF_FFFF)]), .swift, "unsupported"),
            ("stored sizes differ", Self.zip([.init("a.png", png, size: png.count - 1)]), .swift, "notAZip"),
            ("member over the cap", Self.zip([.init("a.png", png)]), Self.caps(member: png.count - 1, members: 200, total: 1_000_000), "tooLarge"),
            ("total over the cap", Self.zip([.init("a.png", png), .init("b.png", png)]), Self.caps(member: 100_000, members: 200, total: png.count * 2 - 1), "tooLarge"),
            ("more members than the cap", Self.zip([.init("a.png", png), .init("b.png", png)]), Self.caps(member: 100_000, members: 1, total: 1_000_000), "tooLarge"),
            ("bad local header", Self.zip([.init("a.png", png, badLocal: true)]), small, "notAZip"),
            ("bytes past the end", Self.zip([.init("a.png", png, deflate: true, compressed: 900_000)]), small, "notAZip"),
            ("unknown method", Self.zip([.init("a.png", png, method: 12)]), small, "unsupported"),
            ("corrupt deflate", Self.zip([.init("a.png", png, deflate: true, garble: true)]), small, "notAZip"),
            ("a good member, then a corrupt one", Self.zip([.init("a.png", png), .init("b.png", png, deflate: true, garble: true)]), small, "notAZip"),
            ("only skipped members", Self.zip([.init("notes.txt", Data("x".utf8)), .init("__MACOSX/._a.png", png)]), .swift, "empty"),
            ("a folder entry is skipped", Self.zip([.init("dir/", Data()), .init("dir/a.png", png)]), .swift, "read 1"),
            ("a member that is no picture", Self.zip([.init("a.png", Data("no picture".utf8))]), .swift, #"unreadable("labs.zip/a.png")"#),
            // Review round 1 (item 4): a deflated member with no bytes but a size is no ZIP, never a crash.
            ("deflated, no bytes, a size", Self.zip([.init("a.png", png, deflate: true, compressed: 0)]), small, "notAZip"),
            // An empty file is read as one: no picture in it, so unreadable, stored or deflated.
            ("an empty stored member", Self.zip([.init("empty.png", Data())]), .swift, #"unreadable("labs.zip/empty.png")"#),
            ("an empty deflated member", Self.zip([.init("empty.png", Data(), method: 8)]), .swift, #"unreadable("labs.zip/empty.png")"#),
            ("the ZIP itself too large", Self.zip([.init("a.png", png)]),
             LabFileReader.Rules(source: .swift, file: { name, bytes in name.hasSuffix(".zip") ? .tooLarge : LabFileReader.swiftVerdict(name, bytes) },
                                 member: LabFileReader.swiftMemberVerdict, maxMemberBytes: 100_000, maxMembers: 200, maxTotalBytes: 1_000_000), #"tooLarge("labs.zip")"#),
        ]
        for (label, zip, rules, expected) in rows {
            var found: String
            do { found = "read \(try await LabFileReader.documents(from: zip, name: "labs.zip", rules: rules).count)" }
            catch { found = String(describing: error) }
            XCTAssertEqual(found, expected, label)
        }
    }

    /// A member converted on its own gives the pages the whole-ZIP read gives, and those are the
    /// pages of the same bytes picked as a file.
    func testAMembersPagesAreThoseOfTheSameFile() async throws {
        let pdf = Self.textPdf
        let zip = Self.zip([.init("r.pdf", pdf, deflate: true), .init("b.png", Self.png)])
        let whole = try await LabFileReader.documents(from: zip, name: "labs.zip")
        let alone = [try await LabFileReader.documents(from: pdf, name: "labs.zip/r.pdf"), try await LabFileReader.documents(from: Self.png, name: "labs.zip/b.png")].flatMap { $0 }
        XCTAssertEqual(whole.map(\.pages), alone.map(\.pages))
        XCTAssertEqual(whole.map(\.name), ["labs.zip/r.pdf", "labs.zip/b.png"])
        XCTAssertTrue(whole[0].pages[0].content.contains("Synthetic Lab Report"))
    }

    // MARK: on demand (AC7f)

    /// Listing reads the central directory only: with every member's header and bytes wiped,
    /// the ZIP still lists each member's path and size; only reading one finds the damage.
    func testListingReadsNoMemberBytes() throws {
        let (zip, start) = Self.built([.init("a.png", Self.png), .init("dir/", Data()), .init("b/c.pdf", Self.textPdf, deflate: true), .init("notes.txt", Data("x".utf8))])
        var wiped = zip
        wiped.replaceSubrange(0..<start, with: Data(count: start))
        let held = LabFileReader.Held()
        held.hold(wiped, as: "z", name: "labs.zip")
        let members = try held.list("z", rules: .swift)
        // Every file member, with no rule applied: health-core's `listed` judges each (notes.txt too).
        XCTAssertEqual(members.map(\.entry.name), ["a.png", "b/c.pdf", "notes.txt"])
        XCTAssertEqual(members.map(\.entry.size), [Self.png.count, Self.textPdf.count, 1])
        XCTAssertEqual(Set(members.map(\.id)).count, 3)
        XCTAssertThrowsError(try held.hash(members[0].id)) { XCTAssertEqual(String(describing: $0), "notAZip") }
    }

    /// A member is inflated only when it is asked for, so a corrupt later member leaves the
    /// earlier ones readable; the whole-ZIP read still refuses that ZIP (the pin above).
    func testACorruptLaterMemberLeavesEarlierOnesReadable() throws {
        let zip = Self.zip([.init("a.png", Self.png, deflate: true), .init("b.png", Self.png, deflate: true, garble: true)])
        let held = LabFileReader.Held()
        held.hold(zip, as: "z", name: "labs.zip")
        let members = try held.list("z", rules: .swift)
        XCTAssertEqual(members.map(\.entry.name), ["a.png", "b.png"])
        let first = try held.convert(members[0].id, rules: .swift)
        XCTAssertEqual(first.name, "labs.zip/a.png")
        XCTAssertEqual(first.zipMember?.zip, "labs.zip")
        XCTAssertEqual(first.zipMember?.path, "a.png")
        XCTAssertEqual(first.original?.verifiedData(), Self.png)
        XCTAssertEqual(try held.hash(members[0].id), LabFileReader.contentHash(Self.png))
        XCTAssertThrowsError(try held.convert(members[1].id, rules: .swift)) { XCTAssertEqual(String(describing: $0), "notAZip") }
    }

    /// A ZIP's kept members are checked when it is listed, as the whole-ZIP read checks them; a member
    /// the rules skip is listed unchecked, and is still refused when read on its own, before any copy.
    func testAMemberReadAloneKeepsTheRefusals() throws {
        let held = LabFileReader.Held()
        let faulty = Self.zip([.init("a.png", Self.png, flags: 1), .init("b.png", Self.png, compressed: 0xFFFF_FFFF),
                               .init("c.png", Self.png, size: Self.png.count - 1), .init("d.png", Self.png, method: 12)])
        held.hold(faulty, as: "z", name: "labs.zip")
        XCTAssertThrowsError(try held.list("z", rules: .swift)) { XCTAssertEqual(String(describing: $0), "unsupported") }
        let found = try held.list("z", rules: Self.keepNothing).map { member in
            do { _ = try held.hash(member.id); return "read" } catch { return String(describing: error) }
        }
        XCTAssertEqual(found, ["unsupported", "unsupported", "notAZip", "unsupported"])
        held.hold(Self.zip([.init("big.pdf", Data(count: LabFileReader.maxFileBytes + 1))]), as: "y", name: "big.zip")
        XCTAssertThrowsError(try held.list("y", rules: .swift)) { XCTAssertEqual(String(describing: $0), "tooLarge") }
        let bigMember = try held.list("y", rules: Self.keepNothing)[0]
        XCTAssertThrowsError(try held.hash(bigMember.id)) { XCTAssertEqual(String(describing: $0), "tooLarge") }
    }

    /// Item 3: `Held` keeps the caps itself. Over the member count or the total, a ZIP is refused
    /// at its listing; members the rules skip are listed unchecked, yet reading them stops at the
    /// total, each member counted once however often it is read. Each member is ~9.9 MB of zeros.
    func testHeldKeepsTheCapsAcrossLazyReads() throws {
        let zeros = Data(count: 9_900_000)
        let held = LabFileReader.Held()
        held.hold(Self.zip((0..<300).map { .init(String(format: "r%03d.pdf", $0), zeros, deflate: true) }), as: "m", name: "many.zip")
        XCTAssertThrowsError(try held.list("m", rules: .swift)) { XCTAssertEqual(String(describing: $0), "tooLarge") }
        XCTAssertThrowsError(try held.hash("m#0")) { XCTAssertEqual(String(describing: $0), #"unreadable("m#0")"#) }
        // That one passes the total (200 MB) first; 201 small members pass the count alone.
        held.hold(Self.zip((0..<201).map { .init(String(format: "c%03d.pdf", $0), Data("x".utf8)) }), as: "c", name: "count.zip")
        XCTAssertThrowsError(try held.list("c", rules: .swift)) { XCTAssertEqual(String(describing: $0), "tooLarge") }
        XCTAssertNoThrow(try held.list("c", rules: Self.caps(member: 10, members: 201, total: 1_000)))
        let caps = Self.caps(member: 10_000_000, members: 200, total: 30_000_000)
        held.hold(Self.zip((0..<4).map { .init("r\($0).pdf", zeros, deflate: true) }), as: "t", name: "total.zip")
        XCTAssertThrowsError(try held.list("t", rules: caps)) { XCTAssertEqual(String(describing: $0), "tooLarge") }
        held.hold(Self.zip([.init("a.png", Self.png)] + (0..<6).map { .init("z\($0).bin", zeros, deflate: true) }), as: "s", name: "skipped.zip")
        let members = try held.list("s", rules: caps)
        let found = members.map { member in
            do { _ = try held.hash(member.id); return "read" } catch { return String(describing: error) }
        }
        XCTAssertEqual(found, ["read", "read", "read", "read", "tooLarge", "tooLarge", "tooLarge"])
        XCTAssertNoThrow(try held.hash(members[1].id), "a member read again is not counted again")
    }

    static let keepNothing = LabFileReader.Rules(source: .swift, file: LabFileReader.swiftVerdict, member: { _ in .unsupported },
                                                 maxMemberBytes: LabFileReader.maxFileBytes, maxMembers: 200, maxTotalBytes: 100_000_000)

    /// The bytes' hash is the web's `sha256Blob` (widget-src/src/lib/archive-payloads.ts) for the
    /// same bytes: bytes 0 to 255, then the line below. Expected value computed once in Node by
    /// running sha256Blob itself (tsx) and checked with node:crypto, 2026-11-15.
    func testAHashIsTheWebsSha256Blob() throws {
        let fixture = Data(0...255) + Data("Synthetic report bytes for US-52 AC7f.\n".utf8)
        let expected = "sha256-9aae0fc6e3b0b4c34b79f6b0af5cbea105ddb1771d6bcd0bdda40d72c6e527e4"
        let held = LabFileReader.Held()
        held.hold(fixture, as: "f", name: "report.pdf")
        XCTAssertEqual(try held.hash("f"), expected)
        held.hold(Self.zip([.init("in/report.pdf", fixture, deflate: true)]), as: "z", name: "labs.zip")
        let listed = try held.list("z", rules: .swift)
        let member = try XCTUnwrap(listed.first)
        XCTAssertEqual(try held.hash(member.id), expected, "a member hashes its inflated bytes")
    }

    /// One member converted on demand gives the pages the same bytes give picked as a file.
    func testConvertingOneMemberGivesTheSamePages() async throws {
        let held = LabFileReader.Held()
        held.hold(Self.zip([.init("b.png", Self.png), .init("r.pdf", Self.textPdf, deflate: true)]), as: "z", name: "labs.zip")
        let members = try held.list("z", rules: .swift)
        let pdf = try held.convert(members[1].id, rules: .swift)
        let alone = try await LabFileReader.documents(from: Self.textPdf, name: "labs.zip/r.pdf")
        XCTAssertEqual(pdf.pages, alone.first?.pages)
        let png = try await LabFileReader.documents(from: Self.png, name: "labs.zip/b.png")
        XCTAssertEqual(try held.convert(members[0].id, rules: .swift).pages, png.first?.pages)
    }

    /// A file's own bytes convert too; `forget` drops what an id holds, and a forgotten ZIP
    /// takes its members with it.
    func testForgetDropsTheBytes() throws {
        let held = LabFileReader.Held()
        held.hold(Self.png, as: "p", name: "scan.png")
        XCTAssertEqual(try held.convert("p", rules: .swift).pages.map(\.type), ["image"])
        XCTAssertNil(try held.convert("p", rules: .swift).zipMember)
        held.hold(Self.zip([.init("a.png", Self.png)]), as: "z", name: "labs.zip")
        let listed = try held.list("z", rules: .swift)
        let member = try XCTUnwrap(listed.first)
        held.forget(["p", "z"])
        XCTAssertThrowsError(try held.hash("p")) { XCTAssertEqual(String(describing: $0), #"unreadable("p")"#) }
        XCTAssertThrowsError(try held.convert(member.id, rules: .swift)) { XCTAssertEqual(String(describing: $0), #"unreadable("z#0")"#) }
    }

    /// The old entry point counts a ZIP's members as it converts them: before each, done and total.
    func testAZipsReadCountsItsMembers() async throws {
        let zip = Self.zip([.init("a.png", Self.png), .init("b.png", Self.png), .init("notes.txt", Data("x".utf8))])
        let seen = Seen()
        let read = try await LabFileReader.documents(from: zip, name: "labs.zip") { done, total in seen.counts.append("\(done) of \(total)") }
        XCTAssertEqual(read.count, 2)
        let counts = await MainActor.run { seen.counts }
        XCTAssertEqual(counts, ["0 of 2", "1 of 2"])
    }

    @MainActor final class Seen { var counts: [String] = [] }

    // MARK: review round 1

    /// Item 1 (US-52 AC7a): a cancelled read converts no later member and publishes no count, so a
    /// late count can never move the next upload's screen. A's first count waits behind a busy main
    /// actor; A is cancelled and B started meanwhile. Member 1 is corrupt: converting it would fail
    /// with notAZip, not CancellationError.
    @MainActor
    func testACancelledZipReadStopsAndPublishesNothing() async throws {
        let zip = Self.zip([.init("a.png", Self.png), .init("b.png", Self.png, deflate: true, garble: true)])
        let first = Seen(), second = Seen()
        let a = Task.detached { try await LabFileReader.documents(from: zip, name: "a.zip") { done, total in first.counts.append("\(done) of \(total)") } }
        Self.holdMain(0.5) // main busy: A lists, then waits to publish its first count
        a.cancel()
        let good = Self.zip([.init("a.png", Self.png), .init("b.png", Self.png)])
        let b = try await LabFileReader.documents(from: good, name: "b.zip") { done, total in second.counts.append("\(done) of \(total)") }
        var failure = "read"
        do { _ = try await a.value } catch { failure = String(describing: error) }
        XCTAssertEqual(failure, "CancellationError()")
        XCTAssertEqual(first.counts, [], "a cancelled read publishes no count")
        XCTAssertEqual(second.counts, ["0 of 2", "1 of 2"])
        XCTAssertEqual(b.count, 2)
    }

    /// Blocks the calling thread (here, main), as a busy screen would.
    private static func holdMain(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }

    /// Item 2: a ZIP held again under the same id, or forgotten and held again, never reads its
    /// members by the old ZIP's directory: until it is listed, a member id is unreadable.
    func testAReheldZipNeverReadsTheOldDirectory() throws {
        let other = UIGraphicsImageRenderer(size: CGSize(width: 30, height: 10)).pngData { _ in }
        let a = Self.zip([.init("a.png", Self.png)])
        let b = Self.zip([.init("long/path/b.png", other, deflate: true)])
        let held = LabFileReader.Held()
        held.hold(a, as: "z", name: "a.zip")
        _ = try held.list("z", rules: .swift)
        held.hold(b, as: "z", name: "b.zip")
        XCTAssertThrowsError(try held.hash("z#0")) { XCTAssertEqual(String(describing: $0), #"unreadable("z#0")"#) }
        _ = try held.list("z", rules: .swift)
        XCTAssertEqual(try held.hash("z#0"), LabFileReader.contentHash(other))
        held.forget(["z"])
        held.hold(a, as: "z", name: "a.zip")
        XCTAssertThrowsError(try held.hash("z#0")) { XCTAssertEqual(String(describing: $0), #"unreadable("z#0")"#) }
    }

    // MARK: fixtures

    static let png = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).pngData { context in
        UIColor.gray.setFill(); context.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
    }

    static let textPdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 612, height: 792)).pdfData { context in
        context.beginPage()
        ("Synthetic Lab Report. Test A 1.0 unit. Collected 2026-01-01." as NSString)
            .draw(in: CGRect(x: 40, y: 40, width: 530, height: 700), withAttributes: [.font: UIFont.systemFont(ofSize: 14)])
    }

    static func caps(member: Int, members: Int, total: Int) -> LabFileReader.Rules {
        LabFileReader.Rules(source: .swift, file: LabFileReader.swiftVerdict, member: LabFileReader.swiftMemberVerdict,
                            maxMemberBytes: member, maxMembers: members, maxTotalBytes: total)
    }

    /// One member as written, with what a test wants to break in it.
    struct Member {
        let name: String, data: Data, deflate: Bool, flags: Int, method: Int?, compressed: Int?, size: Int?, badLocal: Bool, garble: Bool
        init(_ name: String, _ data: Data, deflate: Bool = false, flags: Int = 0, method: Int? = nil, compressed: Int? = nil,
             size: Int? = nil, badLocal: Bool = false, garble: Bool = false) {
            (self.name, self.data, self.deflate, self.flags, self.method, self.compressed, self.size, self.badLocal, self.garble)
                = (name, data, deflate, flags, method, compressed, size, badLocal, garble)
        }
    }

    /// A ZIP with a central directory; `start` is where that directory begins.
    static func zip(_ members: [Member]) -> Data { built(members).data }

    static func built(_ members: [Member]) -> (data: Data, start: Int) {
        var out = Data()
        var central = Data()
        func u16(_ v: Int) -> Data { withUnsafeBytes(of: UInt16(v).littleEndian) { Data($0) } }
        func u32(_ v: Int) -> Data { withUnsafeBytes(of: UInt32(truncatingIfNeeded: v).littleEndian) { Data($0) } }
        for member in members {
            var stored = member.deflate ? deflate(member.data) : member.data
            if member.garble { stored = Data(repeating: 0xFF, count: stored.count) }
            let offset = out.count
            let header = u16(20) + u16(member.flags) + u16(member.method ?? (member.deflate ? 8 : 0)) + u16(0) + u16(0) + u32(0)
                + u32(member.compressed ?? stored.count) + u32(member.size ?? member.data.count) + u16(member.name.utf8.count) + u16(0)
            out += u32(member.badLocal ? 0x1234_5678 : 0x0403_4b50) + header + Data(member.name.utf8) + stored
            central += u32(0x0201_4b50) + u16(20) + header + u16(0) + u16(0) + u16(0) + u32(0) + u32(offset) + Data(member.name.utf8)
        }
        let start = out.count
        out += central
        out += u32(0x0605_4b50) + u16(0) + u16(0) + u16(members.count) + u16(members.count) + u32(central.count) + u32(start) + u16(0)
        return (out, start)
    }

    static func deflate(_ data: Data) -> Data {
        var output = Data(count: data.count + 64)
        let written = output.withUnsafeMutableBytes { out in
            data.withUnsafeBytes { input in
                compression_encode_buffer(out.bindMemory(to: UInt8.self).baseAddress!, data.count + 64,
                                          input.bindMemory(to: UInt8.self).baseAddress!, data.count, nil, COMPRESSION_ZLIB)
            }
        }
        return output.prefix(written)
    }
}
