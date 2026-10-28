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
        XCTAssertEqual(LiveMaths.duration(7 * 3600 + 32 * 60).map { "\($0.number) \($0.unit)" }, ["7 hr", "32 min"])
        XCTAssertEqual(LiveMaths.duration(45 * 60).map { "\($0.number) \($0.unit)" }, ["45 min"])
        XCTAssertEqual(LiveMaths.duration(8 * 3600).map { "\($0.number) \($0.unit)" }, ["8 hr"])
        XCTAssertEqual(LiveMaths.duration(59.6 * 60).map { "\($0.number) \($0.unit)" }, ["1 hr"], "rounded to the minute")
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
        let weeks = LiveMaths.bucket(days, by: .weekOfYear, calendar: calendar)
        XCTAssertEqual(weeks.count, 2)
        XCTAssertEqual(weeks[0].value, 4000, "a week's bar is the daily average")
        XCTAssertEqual(weeks[0].low, 50, "heart rate: the week's lowest")
        XCTAssertEqual(weeks[0].high, 126, "and highest")
        XCTAssertEqual(weeks[1].value, 8500)
        XCTAssertEqual(LiveMaths.bucket(days, by: .day, calendar: calendar), days, "days stay days")
        let months = LiveMaths.bucket(days, by: .month, calendar: calendar)
        XCTAssertEqual(months.count, 1)
        XCTAssertEqual(months[0].value, 5000)
    }

    func testTheHeadlineIsATotalAnAverageOrARange_AC7() {
        let day = Date(timeIntervalSince1970: 0)
        let hours = [LivePoint(start: day, value: 300), LivePoint(start: day.addingTimeInterval(3600), value: 700)]
        XCTAssertEqual(LiveMaths.headline(.steps, range: .day, points: hours), .init(title: "Total", parts: [.init(number: 1000.formatted(.number.grouping(.automatic)), unit: "steps")]))
        XCTAssertEqual(LiveMaths.headline(.steps, range: .week, points: hours).title, "Average")
        XCTAssertEqual(LiveMaths.headline(.steps, range: .week, points: hours).parts.map(\.number), ["500"])
        let heart = [LivePoint(start: day, value: 70, low: 52, high: 140), LivePoint(start: day, value: 80, low: 60, high: 150)]
        XCTAssertEqual(LiveMaths.headline(.heartRate, range: .week, points: heart), .init(title: "Range", parts: [.init(number: "52–150", unit: "bpm")]))
        XCTAssertEqual(LiveMaths.headline(.restingHeartRate, range: .month, points: [LivePoint(start: day, value: 57), LivePoint(start: day, value: 60)]).parts.map(\.number), ["59"])
        XCTAssertEqual(LiveMaths.headline(.vo2Max, range: .year, points: []), .init(title: "Average"), "nothing in view: None")
        XCTAssertEqual(LiveMaths.headline(.heartRate, range: .day, points: []).parts, [])
    }

    // MARK: Cards

    func testACardShowsTheNewestDayAndAWeekOfTrend_AC6() throws {
        let start = try at("2026-10-01T00:00:00Z")
        let days = (0..<10).map { LivePoint(start: start.addingTimeInterval(Double($0) * 86_400), value: Double(60 + $0)) }
            + [LivePoint(start: start.addingTimeInterval(20 * 86_400), value: nil, low: 1, high: 2)]
        // Long after the last day, so the trend is the last seven readings (AC14).
        let (later, utc) = (try at("2026-12-01T00:00:00Z"), try calendar("UTC"))
        let card = try XCTUnwrap(LiveMaths.card(days: days.shuffled(), today: later, calendar: utc))
        XCTAssertEqual(card.value, 69)
        XCTAssertEqual(card.date, start.addingTimeInterval(9 * 86_400))
        XCTAssertEqual(card.trend, [63, 64, 65, 66, 67, 68, 69], "the last seven days, oldest first")
        XCTAssertNil(LiveMaths.card(days: [], today: later, calendar: utc), "no data: no card")
        let heart = try XCTUnwrap(LiveMaths.card(days: days, latest: (value: 74, date: start), today: later, calendar: utc))
        XCTAssertEqual(heart.value, 74, "heart rate's card is its newest sample")
    }

    /// AC14 (Brad 2026-10-25, as Apple Health): the last 30 days' readings, today and the 29
    /// before; with fewer than two there, the last seven however old.
    func testACardsTrendIsTheLast30DaysOrTheLastSeven_AC14() throws {
        let calendar = try calendar("Pacific/Auckland")
        let today = try at("2026-10-26T09:00:00+13:00")
        let day = { (back: Int) in calendar.date(byAdding: .day, value: -back, to: calendar.startOfDay(for: today))! }
        let points = { (backs: [Int]) in backs.enumerated().map { LivePoint(start: day($1), value: Double($0)) } }
        // 40 days back to today: the last 30 are the days 29 back to today.
        let daily = points(Array((0...40).reversed()))
        XCTAssertEqual(LiveMaths.card(days: daily, today: today, calendar: calendar)?.trend, (11...40).map(Double.init))
        // One reading in the 30 days: the last seven, ending on it.
        let sparse = points([300, 250, 200, 150, 120, 90, 60, 45, 3])
        XCTAssertEqual(LiveMaths.card(days: sparse, today: today, calendar: calendar)?.trend, [2, 3, 4, 5, 6, 7, 8])
        // None in the 30 days and fewer than seven in all: all of them.
        XCTAssertEqual(LiveMaths.card(days: points([200, 100, 45]), today: today, calendar: calendar)?.trend, [0, 1, 2])
        // Two in the 30 days: only those.
        XCTAssertEqual(LiveMaths.card(days: points([200, 100, 60, 45, 29, 0]), today: today, calendar: calendar)?.trend, [4, 5])
        // Sleep's nights follow the same rule.
        let nights = (0..<40).map { back in
            LiveMaths.nights([SleepSegment(stage: .asleep, start: day(back).addingTimeInterval(-3600), end: day(back).addingTimeInterval(Double(back % 3 + 5) * 3600), source: "watch")], calendar: calendar)[0]
        }
        let sleep = try XCTUnwrap(LiveMaths.card(nights: nights.shuffled(), today: calendar.startOfDay(for: today), calendar: calendar))
        XCTAssertEqual(sleep.trend, (0..<30).reversed().map { Double($0 % 3 + 6) }, "the last 30 nights, oldest first")
        let oldNights = [nights[39], nights[35], nights[33]]
        XCTAssertEqual(LiveMaths.card(nights: oldNights, today: calendar.startOfDay(for: today), calendar: calendar)?.trend.count, 3)
    }

    func testSleepsCardIsTheNewestNightAsleep_AC9() throws {
        let calendar = try calendar("UTC")
        let nights = LiveMaths.nights([
            SleepSegment(stage: .asleep, start: try at("2026-10-20T23:00:00Z"), end: try at("2026-10-21T06:00:00Z"), source: "watch"),
            SleepSegment(stage: .asleep, start: try at("2026-10-21T23:30:00Z"), end: try at("2026-10-22T07:00:00Z"), source: "watch"),
            SleepSegment(stage: .inBed, start: try at("2026-10-22T22:00:00Z"), end: try at("2026-10-23T06:00:00Z"), source: "phone"),
        ], calendar: calendar)
        let today = try at("2026-10-25T00:00:00Z")
        let card = try XCTUnwrap(LiveMaths.card(nights: Array(nights.prefix(2)), today: today, calendar: calendar))
        XCTAssertEqual(card.value, 7.5 * 3600, "the newest night's time asleep")
        XCTAssertEqual(card.date, try at("2026-10-22T00:00:00Z"))
        XCTAssertEqual(card.trend, [7, 7.5])
        XCTAssertFalse(card.inBed)
        // Codex R3: a newest night recorded only as In Bed shows as time in bed, as Apple Health shows it.
        let inBed = try XCTUnwrap(LiveMaths.card(nights: nights, today: today, calendar: calendar))
        XCTAssertEqual(inBed.value, 8 * 3600)
        XCTAssertEqual(inBed.date, try at("2026-10-23T00:00:00Z"))
        XCTAssertTrue(inBed.inBed)
        XCTAssertEqual(inBed.trend, [7, 7.5, 8])
        XCTAssertNil(LiveMaths.card(nights: [], today: today, calendar: calendar))
    }

    /// Codex R3, AC9: a history recorded only as In Bed (the iPhone's sleep schedule, an
    /// older app) keeps its card and its page, labelled time in bed.
    func testAnInBedOnlyHistoryShowsTimeInBed_R3_AC9() throws {
        let calendar = try calendar("UTC")
        let nights = LiveMaths.nights([
            SleepSegment(stage: .inBed, start: try at("2026-10-20T22:00:00Z"), end: try at("2026-10-21T06:00:00Z"), source: "phone"),
            SleepSegment(stage: .inBed, start: try at("2026-10-21T23:00:00Z"), end: try at("2026-10-22T06:00:00Z"), source: "phone"),
        ], calendar: calendar)
        let card = try XCTUnwrap(LiveMaths.card(nights: nights, today: try at("2026-10-25T00:00:00Z"), calendar: calendar), "an In Bed-only history has a card")
        XCTAssertTrue(card.inBed)
        XCTAssertEqual(card.value, 7 * 3600)
        XCTAssertEqual(card.trend, [8, 7])
        XCTAssertEqual(LiveCardView.spoken(.sleep, card: card, when: "Today"), "Sleep, 7 hr in bed, Today")
        XCTAssertEqual(SleepPage.bars(nights[0]).map(\.0), [.inBed], "the page draws time in bed")
        XCTAssertEqual(SleepPage.bars(nights[0]).first?.1, 8 * 3600)
        XCTAssertNil(LiveMaths.average(nights, \.asleep))
        XCTAssertEqual(LiveMaths.average(nights, \.inBed), 7.5 * 3600)
        XCTAssertEqual(SleepPage.headline(nights), .init(title: "Avg. Time in Bed", parts: LiveMaths.duration(7.5 * 3600)), "W, M and 6M say time in bed")
        XCTAssertEqual(SleepPage.headline(nights.prefix(1) + []), .init(title: "Avg. Time in Bed", parts: LiveMaths.duration(8 * 3600)))
        XCTAssertEqual(SleepPage.headline(night: nights[0]).title, "Time in Bed", "a picked night too")
        XCTAssertTrue(nights[0].isInBedOnly)
    }

    func testTheCardSaysTimeTodayOrTheDay_AC6() throws {
        let calendar = try calendar("Pacific/Auckland")
        let now = try at("2026-10-24T23:00:00Z") // 12:00 on the 25th in Auckland
        let earlier = try at("2026-10-24T21:42:00Z")
        XCTAssertEqual(DayText.when(earlier, time: true, now: now, calendar: calendar),
                       earlier.formatted(Date.FormatStyle(date: .omitted, time: .shortened, calendar: calendar, timeZone: calendar.timeZone)))
        XCTAssertEqual(DayText.when(earlier, now: now, calendar: calendar), "Today")
        XCTAssertEqual(DayText.when(try at("2026-10-24T01:00:00Z"), time: true, now: now, calendar: calendar), "Yesterday")
        let older = try at("2026-10-20T01:00:00Z")
        XCTAssertEqual(DayText.when(older, now: now, calendar: calendar),
                       older.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, calendar: calendar, timeZone: calendar.timeZone)), "then the short date")
    }

    /// US-25 AC17 (Brad 2026-10-25): every My data card, a vital's included, writes its day as
    /// Apple Health does: Today, Yesterday, then the short date.
    func testAVitalsCardSaysTodayYesterdayOrTheDate_US25_AC17() throws {
        let calendar = try calendar("Pacific/Auckland")
        let now = try at("2026-10-24T23:00:00Z") // 12:00 on the 25th in Auckland
        XCTAssertEqual(DayText.when(day: "2026-10-25", now: now, calendar: calendar), "Today")
        XCTAssertEqual(DayText.when(day: "2026-10-24", now: now, calendar: calendar), "Yesterday")
        let older = try XCTUnwrap(DayText.noon("2026-10-20", timeZone: calendar.timeZone))
        XCTAssertEqual(DayText.when(day: "2026-10-20", now: now, calendar: calendar),
                       older.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, calendar: calendar, timeZone: calendar.timeZone)))
        XCTAssertEqual(DayText.when(day: "not a day", now: now, calendar: calendar), "not a day")
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

    /// Adversary R5: the 6 pm cut is the local hour, not 6 h of seconds. Santiago's clocks go
    /// back at midnight on 5 April 2026, so 18:30 plus six real hours is 23:30 the same day.
    func testThe6pmCutIsTheLocalHourWhereClocksChangeAtMidnight_R5() throws {
        let calendar = try calendar("America/Santiago")
        func local(_ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
            calendar.date(from: DateComponents(year: 2026, month: 4, day: day, hour: hour, minute: minute))!
        }
        let evening = SleepSegment(stage: .asleep, start: local(4, 18, 30), end: local(4, 20), source: "watch")
        XCTAssertEqual(LiveMaths.nightDay(of: evening, calendar: calendar), calendar.startOfDay(for: local(5, 12)), "from 6 pm, the next morning's")
        let before = SleepSegment(stage: .asleep, start: local(4, 17, 59), end: local(4, 18, 30), source: "watch")
        XCTAssertEqual(LiveMaths.nightDay(of: before, calendar: calendar), calendar.startOfDay(for: local(4, 12)), "before 6 pm, that day's")
        // September: clocks jump forward at midnight; the cut still holds.
        let spring = SleepSegment(stage: .asleep, start: local(5, 23).addingTimeInterval(153 * 86_400), end: local(5, 23).addingTimeInterval(153 * 86_400 + 3600), source: "watch")
        XCTAssertEqual(LiveMaths.nightDay(of: spring, calendar: calendar),
                       calendar.startOfDay(for: calendar.date(byAdding: .day, value: 1, to: spring.start)!), "a September night")
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
        XCTAssertEqual(LiveMaths.average(nights, \.asleep), (7 + 5 + 9) * 3600 / 3)
        let averages = LiveMaths.stageAverages(nights)
        XCTAssertEqual(averages[.core], 5.5 * 3600, "of the two nights with stages")
        XCTAssertEqual(averages[.deep], 0.5 * 3600)
        XCTAssertEqual(averages[.rem], 0)
        XCTAssertNil(LiveMaths.average([], \.asleep))
        XCTAssertEqual(LiveMaths.stageAverages([]), [:])
    }

    /// Adversary R3: a nap after 6 pm today is dated tomorrow, so D opens on last night.
    func testDOpensOnTheNewestNightUpToToday_R3() throws {
        let calendar = try calendar("UTC")
        let nights = LiveMaths.nights([
            SleepSegment(stage: .core, start: try at("2026-10-24T23:00:00Z"), end: try at("2026-10-25T06:00:00Z"), source: "watch"),
            SleepSegment(stage: .asleep, start: try at("2026-10-25T18:30:00Z"), end: try at("2026-10-25T19:30:00Z"), source: "watch"),
        ], calendar: calendar)
        let today = try at("2026-10-25T00:00:00Z")
        XCTAssertEqual(nights.map(\.day), [today, try at("2026-10-26T00:00:00Z")], "the nap is tomorrow's")
        XCTAssertEqual(LiveMaths.newestNight(nights, today: today)?.day, today)
        XCTAssertEqual(LiveMaths.card(nights: nights, today: today, calendar: calendar)?.date, today)
    }

    // MARK: Pages

    /// Codex R2: a page opens with its card's reading in view, however old, in every range.
    func testAPageOpensWithItsCardsReadingInView_R2() throws {
        let calendar = try calendar("Pacific/Auckland")
        let now = try at("2026-10-25T02:00:00Z")
        for days in [0.0, 45, 500] {
            let reading = now.addingTimeInterval(-days * 86_400)
            for range in LiveRange.allCases {
                let first = LiveHealth.pageStart(reaching: reading, back: 400, now: now, calendar: calendar)
                let geometry = LiveChartGeometry(range: range, now: now, calendar: calendar, first: first)
                let bucket = range == .day ? Calendar.Component.hour : range.bucket
                let bar = LivePoint(start: try XCTUnwrap(calendar.dateInterval(of: bucket, for: reading)).start, value: 1)
                let opening = geometry.opening(showing: reading)
                XCTAssertEqual(geometry.inView([bar], by: \.start, from: opening), [bar], "\(range.rawValue), \(days) days back")
                if days == 0 { XCTAssertEqual(opening, geometry.windowStart, "a recent reading opens at the end") }
            }
        }
        XCTAssertEqual(LiveMetric.vo2Max.empty, "No VO2 max data in Apple Health for this time.", "the display name, not \"vo2 max\"")
    }

    /// Adversary R8: the audio graph describes the bars in view only.
    func testTheAudioGraphDescribesOnlyWhatIsInView_R8() throws {
        let calendar = try calendar("UTC")
        let now = try at("2026-10-25T12:00:00Z")
        let today = calendar.startOfDay(for: now)
        let days = (0..<30).map { LivePoint(start: today.addingTimeInterval(Double(-$0) * 86_400), value: 60, low: 50, high: 120) }.reversed()
        let geometry = LiveChartGeometry(range: .week, now: now, calendar: calendar, first: days.first?.start)
        let steps = LiveChartDescriptor(metric: .steps, points: Array(days), geometry: geometry, from: geometry.windowStart).makeChartDescriptor()
        XCTAssertEqual(steps.series.map(\.dataPoints.count), [7], "a week in view, not 30 days")
        let heart = LiveChartDescriptor(metric: .heartRate, points: Array(days), geometry: geometry, from: geometry.windowStart).makeChartDescriptor()
        XCTAssertEqual(heart.series.map(\.name), ["Lowest", "Highest"])
        XCTAssertEqual(heart.series.map(\.dataPoints.count), [7, 7])
        let sleep = LiveMaths.nights((0..<30).map { back in
            let wake = today.addingTimeInterval(Double(-back) * 86_400 + 6 * 3600)
            return SleepSegment(stage: .core, start: wake.addingTimeInterval(-7 * 3600), end: wake, source: "watch")
        }, calendar: calendar)
        let nights = LiveChartGeometry(range: .week, now: now, calendar: calendar, first: sleep.first?.day)
        XCTAssertEqual(SleepRangeDescriptor(nights: sleep, geometry: nights, from: nights.windowStart).makeChartDescriptor().series.first?.dataPoints.count, 7)
    }

    /// Codex R3: an In Bed-only history's audio graphs say time in bed, not time asleep.
    func testInBedOnlyAudioGraphsSayTimeInBed_R3() throws {
        let calendar = try calendar("UTC")
        let now = try at("2026-10-23T12:00:00Z")
        let inBed = LiveMaths.nights([
            SleepSegment(stage: .inBed, start: try at("2026-10-20T22:00:00Z"), end: try at("2026-10-21T06:00:00Z"), source: "phone"),
            SleepSegment(stage: .inBed, start: try at("2026-10-21T23:00:00Z"), end: try at("2026-10-22T06:00:00Z"), source: "phone"),
        ], calendar: calendar)
        let geometry = LiveChartGeometry(range: .week, now: now, calendar: calendar, first: inBed.first?.day)
        let range = SleepRangeDescriptor(nights: inBed, geometry: geometry, from: geometry.windowStart).makeChartDescriptor()
        XCTAssertEqual(range.title, "Time in bed")
        XCTAssertEqual(range.yAxis?.title, "Time in bed")
        XCTAssertEqual(range.series.map(\.name), ["Time in bed"])
        let night = SleepNightDescriptor(night: inBed[0], rows: [.inBed], calendar: calendar).makeChartDescriptor()
        XCTAssertEqual(night.title, "Time in bed")
        XCTAssertEqual(night.series.map(\.name), ["Time in bed"])
        let asleep = LiveMaths.nights([SleepSegment(stage: .core, start: try at("2026-10-21T23:00:00Z"), end: try at("2026-10-22T06:00:00Z"), source: "watch")], calendar: calendar)
        XCTAssertEqual(SleepRangeDescriptor(nights: asleep + inBed, geometry: geometry, from: geometry.windowStart).makeChartDescriptor().title, "Time asleep")
        XCTAssertEqual(SleepNightDescriptor(night: asleep[0], rows: SleepStage.drawn, calendar: calendar).makeChartDescriptor().title, "Sleep stages")
    }

    /// N4: with nights asleep and nights only in bed in view, the audio graph plots what the
    /// headline averages: time asleep, of the nights with sleep.
    func testAMixedWeeksAudioGraphPlotsTimeAsleep_N4() throws {
        let calendar = try calendar("UTC")
        let nights = LiveMaths.nights([
            SleepSegment(stage: .core, start: try at("2026-10-20T23:00:00Z"), end: try at("2026-10-21T06:00:00Z"), source: "watch"),
            SleepSegment(stage: .inBed, start: try at("2026-10-21T22:00:00Z"), end: try at("2026-10-22T07:00:00Z"), source: "phone"),
        ], calendar: calendar)
        let geometry = LiveChartGeometry(range: .week, now: try at("2026-10-23T12:00:00Z"), calendar: calendar, first: nights.first?.day)
        let graph = SleepRangeDescriptor(nights: nights, geometry: geometry, from: geometry.windowStart).makeChartDescriptor()
        XCTAssertEqual(graph.title, "Time asleep")
        XCTAssertEqual(graph.series.first?.dataPoints.count, 1, "the asleep night only")
        XCTAssertEqual((graph.yAxis as? AXNumericDataAxisDescriptor)?.range.upperBound, 7, "plotted in hours asleep, not in bed")
        XCTAssertEqual(SleepPage.headline(nights).title, "Avg. Time Asleep", "as the headline reads")
    }

    /// N5: after midnight, a D window on the day that was today moves to the new today; one
    /// the person scrolled back stays.
    func testDFollowsMidnight_N5() throws {
        let calendar = try calendar("Pacific/Auckland")
        let now = try at("2026-10-25T12:30:00Z") // 01:30 on the 26th in Auckland
        let geometry = LiveChartGeometry(range: .day, now: now, calendar: calendar, first: now.addingTimeInterval(-7 * 86_400))
        let today = calendar.startOfDay(for: now)
        let yesterday = try XCTUnwrap(calendar.date(byAdding: .day, value: -1, to: today))
        XCTAssertEqual(geometry.following(yesterday, wasToday: yesterday), geometry.windowStart, "it was showing today: follow")
        XCTAssertEqual(geometry.windowStart, today)
        let before = try XCTUnwrap(calendar.date(byAdding: .day, value: -2, to: today))
        XCTAssertNil(geometry.following(before, wasToday: yesterday), "scrolled back: stays")
        XCTAssertNil(geometry.following(today, wasToday: today), "the same day: nothing moves")
    }

    /// N7: the sleep chart lands on the card's night once the nights arrive, even when the
    /// range changed before they did; afterwards it stays where the person left it.
    func testSleepLandsOnTheCardsNight_N7() throws {
        let calendar = try calendar("UTC")
        let now = try at("2026-10-25T12:00:00Z")
        let night = try at("2026-06-01T00:00:00Z")
        let before = LiveChartGeometry(range: .week, now: now, calendar: calendar, first: nil)
        let early = before.opening(showing: night)
        let after = LiveChartGeometry(range: .week, now: now, calendar: calendar, first: night)
        let landed = SleepPage.landed(opening: true, scrolledTo: early, geometry: after, reading: night)
        XCTAssertEqual(after.inView([night], by: \.self, from: landed), [night], "the card's night in view")
        XCTAssertTrue(before.inView([night], by: \.self, from: early).isEmpty, "which the early position missed")
        XCTAssertEqual(SleepPage.landed(opening: false, scrolledTo: early, geometry: after, reading: night), early)
    }

    /// Review 2026-10-25: a scrolling chart labels no tick within 6% of a visible edge, where
    /// the label would be cut ("/lay", "Mo").
    func testAxisLabelsSkipTheEdges() {
        let start = Date(timeIntervalSince1970: 0)
        let week = 7 * 86_400.0
        XCTAssertFalse(ChartRange.labels(start, from: start, length: week))
        XCTAssertFalse(ChartRange.labels(start.addingTimeInterval(week), from: start, length: week))
        XCTAssertTrue(ChartRange.labels(start.addingTimeInterval(86_400), from: start, length: week))
        XCTAssertTrue(ChartRange.labels(start.addingTimeInterval(6 * 86_400), from: start, length: week))
    }

    /// The aggregation drives each metric's statistics, headline, mark and card rule.
    func testEachMetricsAggregation() {
        XCTAssertEqual(LiveMetric.allCases.map(\.aggregation), [.range, .mean, .sum, .mean, .sum])
        XCTAssertEqual(LiveMetric.allCases.map(\.opening), [.day, .week, .day, .sixMonths, .day])
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
