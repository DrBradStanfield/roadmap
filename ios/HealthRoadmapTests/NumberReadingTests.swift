import XCTest
@testable import HealthRoadmap

/// US-25 AC21: a typed number is read in Swift (`TypedNumber.read`), so typing never waits
/// on the engine. It must read every text exactly as the engine's own rule does
/// (`numberJson`: `readNumber` over health-core's `parseLocalisedNumber`).
final class NumberReadingTests: XCTestCase {
    private static let texts = [
        // Plain decimals, either mark (adversary R2: a German phone read "3.4" as 3).
        "3.4", "3,4", "0.1", "007", "5.", ".5", "+5", "-5", "+.5", "-.5", "-0", "0", "70",
        "0.30000000000000004", "123456789012345678901234567890", String(repeating: "9", count: 400),
        // Not plain decimals.
        "", " ", ".", "-", "+", "3.4.5", "1,234.5", "1e3", "0x10", "Infinity", "NaN", "1_000", "12 3", "--5", "5-",
        // JavaScript's trim: spaces, tabs, line ends, no-break and other Unicode spaces.
        " 3.4 ", "\t42\n", "\u{00A0}5\u{00A0}", "\u{FEFF}7", "\u{2003}8\u{3000}", "\u{2028}4\u{2029}", "\u{000B}6\u{000C}",
        // What trim leaves: a next-line mark, the Mongolian vowel separator, a zero-width space.
        "\u{0085}9", "\u{180E}1", "\u{200B}2",
        // Arabic-Indic and extended digits and the Arabic decimal mark; other scripts' digits are not read.
        "١٢٫٥", "۱۲٫۵", "١,٥", "٣", "５", "१२",
    ]

    func testSwiftReadsEveryTextAsTheEngineDoes() throws {
        let engine = try HealthEngine()
        for text in Self.texts {
            let expected = try engine.blocking { try $0.number(from: text) }
            let read = TypedNumber.read(text)
            XCTAssertEqual(read, expected, "\(text.debugDescription)")
            if let read, let expected { XCTAssertEqual(read.sign, expected.sign, "\(text.debugDescription): the sign of zero") }
        }
    }

    func testTheEdgeCasesReadAsTheWebsRuleSays() {
        XCTAssertEqual(TypedNumber.read("3,4"), 3.4)
        XCTAssertEqual(TypedNumber.read("١٢٫٥"), 12.5)
        XCTAssertNil(TypedNumber.read("1e3"), "Number() would read it; a plain decimal rule does not")
        XCTAssertNil(TypedNumber.read(String(repeating: "9", count: 400)), "too large to be finite")
        XCTAssertEqual(TypedNumber.read("-0")?.sign, .plus, "the engine answers JSON, where -0 is 0")
    }
}
