import XCTest
@testable import HealthRoadmap

/// US-56 AC8: the VO2 max fitness bands. The engine serves the person's FRIEND 2022 row on
/// My data (`vo2Bands`; its table, ages and sexes are tested in ios/engine/vo2-bands.test.ts);
/// the app applies the cut-points to a value.
final class Vo2MaxBandsTests: XCTestCase {
    /// A man aged 40 to 49.
    private let men40 = Vo2MaxBands(sex: "male", fromAge: 40, toAge: 49, p20: 26.7, p50: 35.3, p80: 45.2)
    /// A woman aged 40 to 49.
    private let women40 = Vo2MaxBands(sex: "female", fromAge: 40, toAge: 49, p20: 19.7, p50: 25.7, p80: 33.0)

    func testTheEnginesRowIsReadLeniently_AC8() throws {
        let row = #"{"sex":"female","fromAge":40,"toAge":49,"p20":19.7,"p50":25.7,"p80":33}"#
        XCTAssertEqual(try JSONDecoder().decode(Lenient<Vo2MaxBands>.self, from: Data(row.utf8)).value, women40)
        XCTAssertNil(try JSONDecoder().decode(Lenient<Vo2MaxBands>.self, from: Data(#"{"sex":"female"}"#.utf8)).value, "a malformed row shows no bands")
        XCTAssertNil(try JSONDecoder().decode(Lenient<Vo2MaxBands>.self, from: Data(#""bands""#.utf8)).value)
    }

    func testEachBandIncludesItsLowerBound_AC8() {
        XCTAssertEqual(men40.band(26.6), .low)
        XCTAssertEqual(men40.band(26.7), .belowAverage)
        XCTAssertEqual(men40.band(35.2), .belowAverage)
        XCTAssertEqual(men40.band(35.3), .aboveAverage)
        XCTAssertEqual(men40.band(45.1), .aboveAverage)
        XCTAssertEqual(men40.band(45.2), .high)
        XCTAssertEqual(Vo2MaxBand.allCases.map(\.label), ["Low", "Below Average", "Above Average", "High"])
    }

    func testAValueIsPlacedShownAndPlottedAtOneRoundedValue_AC8() {
        // 35.27 shows as 35.3: Above Average. 26.64 shows as 26.6: Low. At a tie the value
        // rounds to even: 35.25 is 35.2 (Below Average), 26.65 is 26.6 (Low), 45.15 is 45.2 (High).
        XCTAssertEqual(Vo2MaxBands.shown(35.27), 35.3)
        XCTAssertEqual(men40.band(35.27), .aboveAverage)
        XCTAssertEqual(men40.band(26.64), .low)
        XCTAssertEqual(men40.band(35.25), .belowAverage)
        XCTAssertEqual(men40.band(26.65), .low)
        XCTAssertEqual(men40.band(45.15), .high)
        for value in [35.25, 26.65, 45.15, 35.27, 26.64, 33.05, 19.65] {
            XCTAssertEqual(LiveMetric.vo2Max.text(value), Vo2MaxBands.shown(value).formatted(.number.precision(.fractionLength(1))), "\(value) shows as it is placed")
        }
    }

    func testTheLegendGivesEachBandsRangeAsShown_AC8() {
        XCTAssertEqual(women40.title, "women aged 40 to 49")
        XCTAssertEqual(Vo2MaxBand.allCases.map { women40.range($0) }, ["Below 19.7", "19.7 to 25.6", "25.7 to 32.9", "33.0 and above"])
        XCTAssertEqual(women40.spoken(.aboveAverage), "Above Average, 25.7 to 32.9 millilitres per kilogram per minute")
        XCTAssertEqual(women40.spoken(.low), "Low, below 19.7 millilitres per kilogram per minute", "lower case mid-sentence")
    }

    func testTheChartShowsEveryBandAndEveryValue_AC8() {
        let domain = men40.yDomain(values: [38, 41])
        XCTAssertLessThan(domain.lowerBound, 26.7)
        XCTAssertGreaterThan(domain.upperBound, 45.2)
        let wide = men40.yDomain(values: [12, 60])
        XCTAssertLessThan(wide.lowerBound, 12)
        XCTAssertGreaterThan(wide.upperBound, 60)
        // Each band's shading runs from its lower bound to the next one's, the outer two to the axis.
        XCTAssertEqual(men40.shade(.low, in: domain), domain.lowerBound...26.7)
        XCTAssertEqual(men40.shade(.belowAverage, in: domain), 26.7...35.3)
        XCTAssertEqual(men40.shade(.high, in: domain), 45.2...domain.upperBound)
        XCTAssertEqual(men40.cuts, [26.7, 35.3, 45.2])
    }

    func testVoiceOverHearsTheBandsInTheAudioGraph_AC8() throws {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let now = try Date("2026-10-26T12:00:00Z", strategy: .iso8601)
        let geometry = LiveChartGeometry(range: .sixMonths, now: now, calendar: utc, first: nil)
        let described = LiveChartDescriptor(metric: .vo2Max, points: [], geometry: geometry, from: geometry.windowStart, bands: women40)
        XCTAssertEqual(described.summary, "Fitness bands for women aged 40 to 49: High, 33.0 and above millilitres per kilogram per minute; Above Average, 25.7 to 32.9 millilitres per kilogram per minute; Below Average, 19.7 to 25.6 millilitres per kilogram per minute; Low, below 19.7 millilitres per kilogram per minute.")
        XCTAssertNil(LiveChartDescriptor(metric: .vo2Max, points: [], geometry: geometry, from: geometry.windowStart).summary)
    }

    /// Brad 2026-10-27: from 60 the Low line is Apple's. For men 80 to 89, 18 sits above FRIEND's
    /// median of 17.6, so there is no Below Average: the legend and the shading leave it out.
    func testAnEmptyBandIsLeftOut_AC8() {
        let men80 = Vo2MaxBands(sex: "male", fromAge: 80, toAge: 89, p20: 18, p50: 17.6, p80: 21.4)
        XCTAssertEqual(men80.present, [.low, .aboveAverage, .high])
        XCTAssertEqual(men80.band(17.9), .low)
        XCTAssertEqual(men80.band(18), .aboveAverage)
        XCTAssertEqual(men80.band(21.3), .aboveAverage)
        XCTAssertEqual(men80.band(21.4), .high)
        XCTAssertEqual(men80.present.map { men80.range($0) }, ["Below 18.0", "18.0 to 21.3", "21.4 and above"])
        let domain = men80.yDomain(values: [19])
        XCTAssertEqual(men80.shade(.low, in: domain), domain.lowerBound...18)
        XCTAssertEqual(men80.shade(.aboveAverage, in: domain), 18...21.4)
        XCTAssertEqual(men80.cuts, [18, 21.4], "no rule at the hidden median")
        XCTAssertEqual(women40.present, Vo2MaxBand.allCases, "a row with room shows all four")
        let geometry = LiveChartGeometry(range: .sixMonths, now: .now, calendar: .current, first: nil)
        XCTAssertFalse(LiveChartDescriptor(metric: .vo2Max, points: [], geometry: geometry, from: geometry.windowStart, bands: men80).summary?.contains("Below Average") ?? true)
    }

    func testTheCardSaysTheBand_AC8() throws {
        let card = LiveCard(value: 38.4, date: try Date("2026-10-20T12:00:00Z", strategy: .iso8601), trend: [])
        XCTAssertEqual(LiveCardView.spoken(.vo2Max, card: card, when: "Tuesday", band: .aboveAverage),
                       "VO2 max, \(LiveMetric.vo2Max.text(38.4)) millilitres per kilogram per minute, Tuesday, Above Average")
        XCTAssertEqual(LiveCardView.spoken(.vo2Max, card: card, when: "Tuesday", band: nil),
                       "VO2 max, \(LiveMetric.vo2Max.text(38.4)) millilitres per kilogram per minute, Tuesday")
    }
}
