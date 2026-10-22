import XCTest
@testable import HealthRoadmap

/// Number boxes refuse, while typed, what no value can be (US-25 AC17b). A refused
/// keystroke or paste is undone, never rewritten into another number.
final class TypedNumberTests: XCTestCase {
    func testBloodPressureTakesThreeWholeDigitsAndNoDecimalMark() {
        XCTAssertTrue(TypedNumber.pressure.accepts("120"))
        XCTAssertTrue(TypedNumber.pressure.accepts(""))
        XCTAssertFalse(TypedNumber.pressure.accepts("7912"))
        XCTAssertFalse(TypedNumber.pressure.accepts("12.5"), "no decimal mark in mmHg")
    }

    func testAValueTakesOneDecimalMarkOfEitherKind() {
        XCTAssertTrue(TypedNumber.value.accepts("5.4"))
        XCTAssertTrue(TypedNumber.value.accepts("5,4"), "the web reads a comma too")
        XCTAssertTrue(TypedNumber.value.accepts("10000"), "PSA's range ends at 10000")
        XCTAssertFalse(TypedNumber.value.accepts("1,234.5"), "a pasted thousands mark is refused, not read as 1.234")
        XCTAssertFalse(TypedNumber.value.accepts("5.4.3"))
        XCTAssertFalse(TypedNumber.value.accepts("123456"))
        XCTAssertFalse(TypedNumber.value.accepts("5.1234"))
        XCTAssertFalse(TypedNumber.value.accepts("-7"))
    }

    func testADoseRunsToTheWebsLimit() {
        XCTAssertTrue(TypedNumber.dose.accepts("50000"))
        XCTAssertTrue(TypedNumber.dose.accepts("2.55"))
        XCTAssertFalse(TypedNumber.dose.accepts("2.555"))
    }
}
