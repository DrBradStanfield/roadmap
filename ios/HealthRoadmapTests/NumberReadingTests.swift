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
        // US-02 AC7: one comma before exactly three digits reads two ways, so neither;
        // two or more comma groups are thousands; a leading 0 or four digits is a decimal.
        "1,234", "1,050", "-1,234", " 12,500 ", "١,٢٣٤", "0,123", "1234,567", "1,2345",
        "1,234,567", "12,345,678", "1,23,456", "1234,567,890",
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

    /// US-02 AC7: with a range, an ambiguous comma is the one reading inside it, as health-core's
    /// `parseLocalisedNumber(text, range)` says: each reading is the engine's own read of the
    /// text with the comma dropped or made a point. Any other text reads as it does unranged.
    func testSwiftReadsARangedTextAsTheEngineDoes() throws {
        let engine = try HealthEngine()
        let ranges: [ClosedRange<Double>] = [0...22.6, 0...2000, 10...2650, 20...300, 0.1...30, 0...3000]
        for text in Self.texts + ["1,500", "100,500", "2,500", "-1,234"] {
            for range in ranges {
                var expected = try engine.blocking { try $0.number(from: text) }
                if TypedNumber.question(text) != nil {
                    let readings = try [text.replacingOccurrences(of: ",", with: ""), text.replacingOccurrences(of: ",", with: ".")]
                        .compactMap { reading in try engine.blocking { try $0.number(from: reading) } }
                        .filter { range.contains($0) }
                    expected = readings.count == 1 ? readings[0] : nil
                }
                XCTAssertEqual(TypedNumber.read(text, range: range), expected, "\(text.debugDescription) in \(range)")
            }
        }
        XCTAssertEqual(TypedNumber.read("1,234", range: 0...22.6), 1.234, "triglycerides in mmol/L")
        XCTAssertEqual(TypedNumber.read("1,234", range: 10...2650), 1234, "creatinine in µmol/L")
        XCTAssertNil(TypedNumber.read("1,234", range: 0...2000), "triglycerides in mg/dL: both fit")
        XCTAssertNil(TypedNumber.question("1,234", range: 0...22.6), "nothing to ask once the range picks one")
    }

    /// US-02 AC7: "1,234" is 1234 or 1.234; the sheet has no range, so it asks.
    func testAnAmbiguousCommaIsAskedAbout() {
        XCTAssertNil(TypedNumber.read("1,234"))
        XCTAssertEqual(TypedNumber.question("1,234"), "Did you mean 1234 or 1.234?")
        XCTAssertEqual(TypedNumber.question("1,050"), "Did you mean 1050 or 1.05?")
        XCTAssertNil(TypedNumber.question("1,2"))
        XCTAssertNil(TypedNumber.question("1234"))
        XCTAssertEqual(TypedNumber.read("1,234,567"), 1_234_567)
    }
}
