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

    /// US-02 AC7: with a range, a typed comma reads as health-core's `parseLocalisedNumber(text,
    /// range)` says. The expected value comes from the engine and `sharedRule` below, never from
    /// Swift's own pattern (adversary R4): every text, unranged and under six ranges.
    func testSwiftReadsARangedTextAsTheEngineDoes() throws {
        let engine = try HealthEngine()
        let ranges: [ClosedRange<Double>?] = [nil, 0...22.6, 0...2000, 10...2650, 20...300, 0.1...30, 0...3000]
        for text in Self.texts + ["1,500", "100,500", "2,500", "-1,234"] {
            for range in ranges {
                let expected = try Self.sharedRule(text, range, engine)
                XCTAssertEqual(TypedNumber.read(text, range: range), expected, "\(text.debugDescription) in \(String(describing: range))")
            }
        }
        XCTAssertEqual(TypedNumber.read("1,234", range: 10...2650), 1234, "creatinine in µmol/L: 1.234 is below the range")
        XCTAssertNil(TypedNumber.read("1,234", range: 0...22.6), "triglycerides in mmol/L: the decimal reading is never chosen")
        XCTAssertNil(TypedNumber.read("2,500", range: 0...2000), "triglycerides in mg/dL: 2500 is over, 2.5 is never chosen")
        XCTAssertNil(TypedNumber.read("1,234", range: 0...2000), "both fit")
        XCTAssertNil(TypedNumber.question("1,234", range: 10...2650), "nothing to ask once the range reads it")
    }

    /// The rule, once, over the engine's own unranged readings: one comma before exactly three
    /// digits (no leading 0) is thousands only inside `range` with the decimal reading below it;
    /// two or more such groups are thousands only with a range; any other text is the engine's.
    private static func sharedRule(_ text: String, _ range: ClosedRange<Double>?, _ engine: HealthEngine) throws -> Double? {
        let read = { (t: String) throws -> Double? in try engine.blocking { try $0.number(from: t) } }
        var body = Substring(text.trimmingCharacters(in: .whitespacesAndNewlines))
        if body.first == "+" || body.first == "-" { body.removeFirst() }
        let groups = body.split(separator: ",", omittingEmptySubsequences: false)
        let grouped = groups.count >= 2 && (1...3).contains(groups[0].count) && groups[0].first.map { !"0٠۰".contains($0) } == true
            && groups.allSatisfy { $0.allSatisfy(\.isNumber) } && groups.dropFirst().allSatisfy { $0.count == 3 }
        guard grouped else { return try read(text) }
        let thousands = try read(text.replacingOccurrences(of: ",", with: ""))
        guard groups.count == 2 else { return range == nil ? nil : thousands }
        guard let range, let thousands, let decimal = try read(text.replacingOccurrences(of: ",", with: ".")),
              range.contains(thousands), decimal < range.lowerBound else { return nil }
        return thousands
    }

    /// US-02 AC7: "1,234" is 1234 or 1.234; the sheet has no range, so it asks.
    func testAnAmbiguousCommaIsAskedAbout() {
        XCTAssertNil(TypedNumber.read("1,234"))
        XCTAssertEqual(TypedNumber.question("1,234"), "Did you mean 1234 or 1.234?")
        XCTAssertEqual(TypedNumber.question("1,050"), "Did you mean 1050 or 1.05?")
        XCTAssertNil(TypedNumber.question("1,2"))
        XCTAssertNil(TypedNumber.question("1234"))
        XCTAssertNil(TypedNumber.read("1,234,567"), "no range to check grouped thousands")
        XCTAssertEqual(TypedNumber.question("1,234,567"), "Type the number without commas.")
        XCTAssertEqual(TypedNumber.read("1,234,567", range: 0...10), 1_234_567, "read, then the engine checks the range")
    }
}

/// Lead I-6: `TypedNumber.question` is a Swift copy of health-core's `commaQuestion`
/// (parseNumber.ts), held to it by nothing but the hand-written cases above. Its parity
/// test waits on an engine door, which is a production change, so only the table is here.
///
/// The missing door: `numberQuestionJson(text, rangeJson?)` in ios/engine/entry.ts (and
/// bridge-contract.json), answering as JSON the question the web asks: null when
/// `parseLocalisedNumber(ascii(text), range)` reads the text, else `commaQuestion(ascii(text))`,
/// where `ascii` is `readNumber`'s step (Arabic-Indic digits and the Arabic decimal mark as
/// ASCII), as `numberJson` reads. A test door beside `number(from:)` in EngineTestDoors.swift
/// then calls it, and one test loops `texts` above plus this table, unranged and under the
/// ranges `testSwiftReadsARangedTextAsTheEngineDoes` uses, asserting
/// `TypedNumber.question(text, range:)` equals the door.
///
/// Expected, from health-core on main 67d3c4eff (unranged unless a range is named):
///
/// | Typed | The engine's question |
/// |---|---|
/// | `1,234` | Did you mean 1234 or 1.234? |
/// | `1,050` | Did you mean 1050 or 1.05? |
/// | `1,000` | Did you mean 1000 or 1? |
/// | `1,500` | Did you mean 1500 or 1.5? |
/// | `100,500` | Did you mean 100500 or 100.5? |
/// | `999,999` | Did you mean 999999 or 999.999? |
/// | `-1,234` | Did you mean -1234 or -1.234? |
/// | `+1,234` | Did you mean 1234 or 1.234? (Swift today: "Did you mean +1234 or +1.234?") |
/// | ` 12,500 ` | Did you mean 12500 or 12.5? |
/// | `\u{00A0}1,234\u{00A0}` | Did you mean 1234 or 1.234? |
/// | `١,٢٣٤`, `۱,۲۳۴` | Did you mean 1234 or 1.234? |
/// | `1,234,567`, `12,345,678`, `-1,234,567`, `+1,234,567`, `١,٢٣٤,٥٦٧` | Type the number without commas. |
/// | `3,4`, `١,٥`, `0,123`, `1234,567`, `1,2345`, `1,2`, `1,23,456`, `1234,567,890` | null |
/// | every other text in `texts` above | null |
/// | `1,234` in 10...2650 | null (the range reads it as 1234) |
/// | `1,234` in 0...2000 | Did you mean 1234 or 1.234? (both readings fit) |
/// | `2,500` in 0...2000 | Did you mean 2500 or 2.5? |
/// | `1,234,567` in 0...10 | null (read; the engine checks the range) |
///
/// The `+1,234` row fails against today's Swift: health-core prints each reading as a
/// JavaScript number, which drops a leading +; Swift keeps the typed text.
