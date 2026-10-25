import XCTest
@testable import HealthRoadmap

/// US-56: the pure maths behind the Apple Health cards and pages (AC2, AC6, AC7, AC9),
/// on fixtures; no HealthKit.
final class LiveMathsTests: XCTestCase {
    private func calendar(_ zone: String) throws -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: zone))
        calendar.locale = Locale(identifier: "en_GB")
        return calendar
    }

    private func at(_ text: String) throws -> Date { try Date(text, strategy: .iso8601) }

    // MARK: Values

    func testSleepIsWrittenInHoursAndMinutes_AC6() {
        XCTAssertEqual(LiveMaths.duration(7 * 3600 + 32 * 60).map { "\($0.0) \($0.1)" }, ["7 hr", "32 min"])
        XCTAssertEqual(LiveMaths.duration(45 * 60).map { "\($0.0) \($0.1)" }, ["45 min"])
        XCTAssertEqual(LiveMaths.duration(8 * 3600).map { "\($0.0) \($0.1)" }, ["8 hr"])
        XCTAssertEqual(LiveMaths.duration(59.6 * 60).map { "\($0.0) \($0.1)" }, ["1 hr"], "rounded to the minute")
        XCTAssertEqual(LiveMetric.sleep.text(6 * 3600 + 5 * 60), "6 hr 5 min")
    }

    func testEachMetricHasOneUnitAndApplesRounding_AC6() {
        XCTAssertEqual(LiveMetric.heartRate.text(71.6), "72")
        XCTAssertEqual(LiveMetric.vo2Max.text(38.44), 38.4.formatted(.number.precision(.fractionLength(1))))
        XCTAssertEqual(LiveMetric.steps.text(8432.4), 8432.formatted(.number.grouping(.automatic)))
        XCTAssertEqual(LiveMetric.allCases.map(\.unit), ["bpm", "bpm", "", "mL/kg/min", "steps"])
        XCTAssertEqual(LiveMetric.vitals, [.heartRate, .restingHeartRate, .sleep])
        XCTAssertEqual(LiveMetric.fitness, [.vo2Max, .steps])
    }

    // MARK: Buckets and headlines

    func testWeeksAndMonthsBucketDaysAsAppleHealthDoes_AC7() throws {
        let calendar = try calendar("UTC")
        let monday = try at("2026-10-19T00:00:00Z")
        let days: [LivePoint] = (0..<9).map { (index: Int) -> LivePoint in
            let n = Double(index)
            return LivePoint(start: monday.addingTimeInterval(n * 86_400), value: 1000 * (n + 1), low: 50 + n, high: 120 + n)
        }
        let weeks = LiveMaths.bucket(days, by: .weekOfYear, metric: .steps, calendar: calendar)
        XCTAssertEqual(weeks.count, 2)
        XCTAssertEqual(weeks[0].value, 4000, "a week's bar is the daily average")
        XCTAssertEqual(weeks[0].low, 50, "heart rate: the week's lowest")
        XCTAssertEqual(weeks[0].high, 126, "and highest")
        XCTAssertEqual(weeks[1].value, 8500)
        XCTAssertEqual(LiveMaths.bucket(days, by: .day, metric: .steps, calendar: calendar), days, "days stay days")
        let months = LiveMaths.bucket(days, by: .month, metric: .restingHeartRate, calendar: calendar)
        XCTAssertEqual(months.count, 1)
        XCTAssertEqual(months[0].value, 5000)
    }

    func testTheHeadlineIsATotalAnAverageOrARange_AC7() {
        let day = Date(timeIntervalSince1970: 0)
        let hours = [LivePoint(start: day, value: 300), LivePoint(start: day.addingTimeInterval(3600), value: 700)]
        XCTAssertEqual(LiveMaths.headline(.steps, range: .day, points: hours), .init(title: "Total", value: 1000.formatted(.number.grouping(.automatic))))
        XCTAssertEqual(LiveMaths.headline(.steps, range: .week, points: hours).title, "Average")
        XCTAssertEqual(LiveMaths.headline(.steps, range: .week, points: hours).value, "500")
        let heart = [LivePoint(start: day, value: 70, low: 52, high: 140), LivePoint(start: day, value: 80, low: 60, high: 150)]
        XCTAssertEqual(LiveMaths.headline(.heartRate, range: .week, points: heart), .init(title: "Range", value: "52–150"))
        XCTAssertEqual(LiveMaths.headline(.restingHeartRate, range: .month, points: [LivePoint(start: day, value: 57), LivePoint(start: day, value: 60)]).value, "59")
        XCTAssertNil(LiveMaths.headline(.vo2Max, range: .year, points: []).value, "nothing in view")
        XCTAssertNil(LiveMaths.headline(.heartRate, range: .day, points: []).value)
    }

    // MARK: Cards

    func testACardShowsTheNewestDayAndAWeekOfTrend_AC6() throws {
        let start = try at("2026-10-01T00:00:00Z")
        let days = (0..<10).map { LivePoint(start: start.addingTimeInterval(Double($0) * 86_400), value: Double(60 + $0)) }
            + [LivePoint(start: start.addingTimeInterval(20 * 86_400), value: nil, low: 1, high: 2)]
        let card = try XCTUnwrap(LiveMaths.card(days: days.shuffled()))
        XCTAssertEqual(card.value, 69)
        XCTAssertEqual(card.date, start.addingTimeInterval(9 * 86_400))
        XCTAssertEqual(card.trend, [63, 64, 65, 66, 67, 68, 69], "the last seven days, oldest first")
        XCTAssertFalse(card.showsTime)
        XCTAssertNil(LiveMaths.card(days: []), "no data: no card")
        let heart = try XCTUnwrap(LiveMaths.card(days: days, latest: (value: 74, date: start)))
        XCTAssertEqual(heart.value, 74, "heart rate's card is its newest sample")
        XCTAssertTrue(heart.showsTime)
    }

    func testSleepsCardIsTheNewestNightAsleep_AC9() throws {
        let calendar = try calendar("UTC")
        let nights = LiveMaths.nights([
            SleepSegment(stage: .asleep, start: try at("2026-10-20T23:00:00Z"), end: try at("2026-10-21T06:00:00Z"), source: "watch"),
            SleepSegment(stage: .asleep, start: try at("2026-10-21T23:30:00Z"), end: try at("2026-10-22T07:00:00Z"), source: "watch"),
            SleepSegment(stage: .inBed, start: try at("2026-10-22T22:00:00Z"), end: try at("2026-10-23T06:00:00Z"), source: "phone"),
        ], calendar: calendar)
        let card = try XCTUnwrap(LiveMaths.card(nights: Array(nights.prefix(2))))
        XCTAssertEqual(card.value, 7.5 * 3600, "the newest night's time asleep")
        XCTAssertEqual(card.date, try at("2026-10-22T00:00:00Z"))
        XCTAssertEqual(card.trend, [7, 7.5])
        XCTAssertFalse(card.inBed)
        // Codex R3: a newest night recorded only as In Bed shows as time in bed, as Apple Health shows it.
        let inBed = try XCTUnwrap(LiveMaths.card(nights: nights))
        XCTAssertEqual(inBed.value, 8 * 3600)
        XCTAssertEqual(inBed.date, try at("2026-10-23T00:00:00Z"))
        XCTAssertTrue(inBed.inBed)
        XCTAssertEqual(inBed.trend, [7, 7.5, 8])
        XCTAssertNil(LiveMaths.card(nights: []))
    }

    /// Codex R3, AC9: a history recorded only as In Bed (the iPhone's sleep schedule, an
    /// older app) keeps its card and its page, labelled time in bed.
    func testAnInBedOnlyHistoryShowsTimeInBed_R3_AC9() throws {
        let calendar = try calendar("UTC")
        let nights = LiveMaths.nights([
            SleepSegment(stage: .inBed, start: try at("2026-10-20T22:00:00Z"), end: try at("2026-10-21T06:00:00Z"), source: "phone"),
            SleepSegment(stage: .inBed, start: try at("2026-10-21T23:00:00Z"), end: try at("2026-10-22T06:00:00Z"), source: "phone"),
        ], calendar: calendar)
        let card = try XCTUnwrap(LiveMaths.card(nights: nights), "an In Bed-only history has a card")
        XCTAssertTrue(card.inBed)
        XCTAssertEqual(card.value, 7 * 3600)
        XCTAssertEqual(card.trend, [8, 7])
        XCTAssertEqual(LiveCardView.spoken(.sleep, card: card, when: "Today"), "Sleep, 7 hr in bed, Today")
        XCTAssertEqual(SleepPage.bars(nights[0]).map(\.0), [.inBed], "the page draws time in bed")
        XCTAssertEqual(SleepPage.bars(nights[0]).first?.1, 8 * 3600)
        XCTAssertNil(LiveMaths.averageAsleep(nights))
        XCTAssertEqual(LiveMaths.averageInBed(nights), 7.5 * 3600)
        XCTAssertEqual(SleepPage.headline(nights), .init(title: "Avg. Time in Bed", seconds: 7.5 * 3600), "W, M and 6M say time in bed")
        XCTAssertEqual(SleepPage.headline(nights.prefix(1) + []), .init(title: "Avg. Time in Bed", seconds: 8 * 3600))
    }

    func testTheCardSaysTimeTodayOrTheDay_AC6() throws {
        let calendar = try calendar("Pacific/Auckland")
        let now = try at("2026-10-24T23:00:00Z") // 12:00 on the 25th in Auckland
        let earlier = try at("2026-10-24T21:42:00Z")
        XCTAssertEqual(LiveMaths.when(earlier, showsTime: true, now: now, calendar: calendar),
                       earlier.formatted(Date.FormatStyle(date: .omitted, time: .shortened, calendar: calendar, timeZone: calendar.timeZone)))
        XCTAssertEqual(LiveMaths.when(earlier, showsTime: false, now: now, calendar: calendar), "Today")
        XCTAssertEqual(LiveMaths.when(try at("2026-10-24T01:00:00Z"), showsTime: true, now: now, calendar: calendar), "Yesterday")
        XCTAssertFalse(LiveMaths.when(try at("2026-10-20T01:00:00Z"), showsTime: false, now: now, calendar: calendar).isEmpty)
    }

    // MARK: Sleep nights

    func testANightIsDatedTheMorningItEndsInAnyZone_AC2_AC9() throws {
        for zone in ["Pacific/Auckland", "America/Los_Angeles", "UTC"] {
            let calendar = try calendar(zone)
            func local(_ day: Int, _ hour: Int) -> Date {
                calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour))!
            }
            let wake = calendar.startOfDay(for: local(24, 12))
            let night = [
                SleepSegment(stage: .core, start: local(23, 23), end: local(24, 2), source: "watch"),
                SleepSegment(stage: .deep, start: local(24, 2), end: local(24, 3), source: "watch"),
                SleepSegment(stage: .rem, start: local(24, 3), end: local(24, 7), source: "watch"),
            ]
            let nights = LiveMaths.nights(night, calendar: calendar)
            XCTAssertEqual(nights.map(\.day), [wake], "\(zone): one night, the day it ends")
            XCTAssertEqual(nights.first?.asleep, 8 * 3600, zone)
            let evening = SleepSegment(stage: .asleep, start: local(24, 18), end: local(24, 19), source: "watch")
            let nap = SleepSegment(stage: .asleep, start: local(24, 15), end: local(24, 16), source: "watch")
            XCTAssertEqual(LiveMaths.nightDay(of: evening, calendar: calendar), calendar.startOfDay(for: local(25, 12)), "\(zone): from 6 pm, the next morning's")
            XCTAssertEqual(LiveMaths.nightDay(of: nap, calendar: calendar), wake, "\(zone): an afternoon nap is that day's")
        }
    }

    func testTheWriterWithStagesDrawsTheNight_AC9() throws {
        let calendar = try calendar("UTC")
        let segments = [
            SleepSegment(stage: .inBed, start: try at("2026-10-23T22:00:00Z"), end: try at("2026-10-24T07:00:00Z"), source: "phone"),
            SleepSegment(stage: .asleep, start: try at("2026-10-23T22:30:00Z"), end: try at("2026-10-24T06:30:00Z"), source: "app"),
            SleepSegment(stage: .core, start: try at("2026-10-23T23:00:00Z"), end: try at("2026-10-24T02:00:00Z"), source: "watch"),
            SleepSegment(stage: .awake, start: try at("2026-10-24T02:00:00Z"), end: try at("2026-10-24T02:15:00Z"), source: "watch"),
            SleepSegment(stage: .deep, start: try at("2026-10-24T02:15:00Z"), end: try at("2026-10-24T03:15:00Z"), source: "watch"),
            // A repeated sample overlaps its neighbour: counted once.
            SleepSegment(stage: .rem, start: try at("2026-10-24T03:15:00Z"), end: try at("2026-10-24T05:00:00Z"), source: "watch"),
            SleepSegment(stage: .rem, start: try at("2026-10-24T04:00:00Z"), end: try at("2026-10-24T05:15:00Z"), source: "watch"),
        ]
        let night = try XCTUnwrap(LiveMaths.nights(segments, calendar: calendar).first)
        XCTAssertTrue(night.hasStages)
        XCTAssertEqual(night.stages[.core], 3 * 3600)
        XCTAssertEqual(night.stages[.deep], 3600)
        XCTAssertEqual(night.stages[.rem], 2 * 3600, "an overlap counted once")
        XCTAssertEqual(night.stages[.awake], 15 * 60)
        XCTAssertEqual(night.asleep, 6 * 3600, "the watch's stages, not the app's asleep beside them")
        XCTAssertEqual(night.inBed, 9 * 3600, "in bed from the phone")
        XCTAssertFalse(night.segments.contains { $0.source == "app" })
    }

    func testANightWithoutStagesShowsAsleepAsRecorded_AC9() throws {
        let calendar = try calendar("UTC")
        let segments = [
            SleepSegment(stage: .asleep, start: try at("2026-10-23T23:00:00Z"), end: try at("2026-10-24T04:00:00Z"), source: "old watch"),
            SleepSegment(stage: .asleep, start: try at("2026-10-24T03:00:00Z"), end: try at("2026-10-24T06:00:00Z"), source: "app"),
        ]
        let night = try XCTUnwrap(LiveMaths.nights(segments, calendar: calendar).first)
        XCTAssertFalse(night.hasStages)
        XCTAssertEqual(night.stages, [:])
        XCTAssertEqual(night.asleep, 7 * 3600, "both writers' asleep, joined")
        XCTAssertEqual(SleepPage.bars(night).map(\.0), [.asleep])
    }

    func testAveragesAreOfNightsWithSleep_AC9() throws {
        let calendar = try calendar("UTC")
        let nights = LiveMaths.nights([
            SleepSegment(stage: .core, start: try at("2026-10-20T23:00:00Z"), end: try at("2026-10-21T05:00:00Z"), source: "w"),
            SleepSegment(stage: .deep, start: try at("2026-10-21T05:00:00Z"), end: try at("2026-10-21T06:00:00Z"), source: "w"),
            SleepSegment(stage: .core, start: try at("2026-10-21T23:00:00Z"), end: try at("2026-10-22T04:00:00Z"), source: "w"),
            SleepSegment(stage: .asleep, start: try at("2026-10-22T23:00:00Z"), end: try at("2026-10-23T08:00:00Z"), source: "old"),
        ], calendar: calendar)
        XCTAssertEqual(LiveMaths.averageAsleep(nights), (7 + 5 + 9) * 3600 / 3)
        let averages = LiveMaths.stageAverages(nights)
        XCTAssertEqual(averages[.core], 5.5 * 3600, "of the two nights with stages")
        XCTAssertEqual(averages[.deep], 0.5 * 3600)
        XCTAssertEqual(averages[.rem], 0)
        XCTAssertNil(LiveMaths.averageAsleep([]))
        XCTAssertEqual(LiveMaths.stageAverages([]), [:])
    }

    func testCoveredCountsOverlapsOnce() {
        let t = { (h: Double) in Date(timeIntervalSince1970: h * 3600) }
        XCTAssertEqual(LiveMaths.covered([(t(0), t(2)), (t(1), t(3)), (t(5), t(6)), (t(4), t(4))]), 4 * 3600)
        XCTAssertEqual(LiveMaths.covered([]), 0)
    }

    // MARK: Colours and the screen name

    /// AC6 with US-25 AC17: each new metric's graph colour is in the one palette, whose
    /// test (MyDataLayoutTests) checks every colour is its own and 3:1 on its card.
    func testEveryLiveMetricHasAPaletteColour_AC6() {
        for metric in LiveMetric.allCases {
            XCTAssertNotNil(MetricChart.palette[metric.paletteKey], metric.label)
        }
    }

    /// The usage signal: one fixed screen name, no metric and no value in it.
    func testTheMetricPagesScreenNameIsFixed() {
        XCTAssertEqual(Analytics.Screen.appleHealthMetric.rawValue, "Apple Health metric")
    }
}
