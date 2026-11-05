import Foundation

/// Each US-56 page's history, kept on this iPhone so a page draws at once (AC7a; Brad
/// 2026-11-03: "store it so that we can quickly load it and we don't have to keep fetching
/// it"). One file per metric for its days, one for its last week of hours (D), and one for
/// sleep's samples, beside the cards' kept readings in Application Support/Apple Health: out of
/// backups, apart from the record, so no sync, export or chat summary reaches them. An actor,
/// so reading, decoding, merging, grouping and writing all run off the main thread; pages get
/// only the finished arrays. The first read takes the whole history, from the oldest sample (not
/// before 2014). Each later one asks HealthKit only what changed since the kept anchor: the days
/// an added sample falls on are read again (a Watch's late sync), and sleep's samples are added
/// or removed by id. A deleted day sample, a change list past HealthKit's limit, or a new time
/// zone reads the days in full again, since HealthKit does not say which day a deleted sample
/// was on. Nothing is logged.
actor LiveHistory {
    /// HealthKit began in 2014; a sample dated earlier is an importer's artifact (adversary R3).
    static let floor = Date(timeIntervalSince1970: 1_388_534_400) // 2014-01-01T00:00Z
    /// D keeps this many days back from today.
    static let week = 7

    /// Where the files go; nil keeps them in memory only.
    private let folder: URL?
    private var days: [LiveMetric: KeptDays] = [:]
    private var hours: [LiveMetric: KeptHours] = [:]
    private var sleep: KeptSleep?
    /// Bumped by every removal: a read begun before it is not kept.
    private var epoch = 0
    /// Writes and removals so far, and how many ran on the main thread (tests).
    private(set) var writes = 0
    private(set) var writesOnMain = 0

    init(folder: URL?) {
        self.folder = folder
    }

    // MARK: Days

    /// The metric's kept days, or nil when none are kept yet.
    func keptDays(_ metric: LiveMetric) -> [LivePoint]? {
        loadDays(metric)?.points
    }

    /// Brings the kept days up to date and returns them: what changed since the kept anchor, or
    /// everything the first time (and after a deleted sample, a long change list or a new time
    /// zone). Health holding none of the metric removes its file. Throws, and keeps what it had,
    /// when HealthKit fails or the phone is locked.
    func refreshDays(_ store: any LiveHealthStore, _ metric: LiveMetric, now: Date, calendar: Calendar) async throws -> [LivePoint] {
        let begun = epoch
        let zone = calendar.timeZone.identifier
        guard let kept = loadDays(metric), kept.zone == zone, let anchor = kept.anchor else {
            return try await readAllDays(store, metric, now: now, calendar: calendar, begun: begun)
        }
        let change = try await store.changes(metric, after: anchor, from: nil)
        try Task.checkCancellation()
        guard change.deleted.isEmpty, !change.more else {
            return try await readAllDays(store, metric, now: now, calendar: calendar, begun: begun)
        }
        var file = KeptDays(zone: zone, oldest: kept.oldest, anchor: change.anchor ?? anchor, points: kept.points)
        // The days the added samples fall on, read again as one span.
        if let first = change.added.min(), let last = change.added.max() {
            let from = max(calendar.startOfDay(for: first), calendar.startOfDay(for: Self.floor))
            let to = min(calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: last)) ?? now, now)
            if from < to {
                let read = try await store.points(metric, from: from, to: to, every: .day)
                try Task.checkCancellation()
                let kept = file.points.filter { $0.start < from || $0.start >= to }
                file = KeptDays(zone: zone, oldest: min(file.oldest, from), anchor: file.anchor,
                                points: (kept + read.filter { $0.start >= from && $0.start < to }).sorted { $0.start < $1.start })
            }
        }
        if begun == epoch {
            days[metric] = file
            write(file, to: Self.daysFile(metric))
        }
        return file.points
    }

    /// Every day from the oldest sample, with the anchor taken first, so a sample added during
    /// the read is seen next time.
    private func readAllDays(_ store: any LiveHealthStore, _ metric: LiveMetric, now: Date, calendar: Calendar, begun: Int) async throws -> [LivePoint] {
        let anchor = try await store.changes(metric, after: nil, from: now.addingTimeInterval(-3600)).anchor
        guard let first = try await store.earliest(metric) else {
            if begun == epoch { remove(metric) }
            return []
        }
        let oldest = calendar.startOfDay(for: max(first, Self.floor))
        let read = try await store.points(metric, from: oldest, to: now, every: .day)
        try Task.checkCancellation()
        let file = KeptDays(zone: calendar.timeZone.identifier, oldest: oldest, anchor: anchor, points: read.filter { $0.start >= oldest })
        if begun == epoch {
            days[metric] = file
            write(file, to: Self.daysFile(metric))
        }
        return file.points
    }

    /// The days grouped as each range draws them: days, weeks (6M) and months (Y).
    func grouped(_ points: [LivePoint], calendar: Calendar) -> [Calendar.Component: [LivePoint]] {
        Dictionary(uniqueKeysWithValues: [Calendar.Component.day, .weekOfYear, .month].map { ($0, LiveMaths.bucket(points, by: $0, calendar: calendar)) })
    }

    // MARK: Hours

    /// The metric's kept hours (the last week, for D) in this time zone, or nil.
    func keptHours(_ metric: LiveMetric, calendar: Calendar) -> [LivePoint]? {
        loadHours(metric).flatMap { $0.zone == calendar.timeZone.identifier ? $0.points : nil }
    }

    /// Reads the hours of the day holding `day` (D) and returns them. Kept only while that day
    /// is within the last week; a day scrolled back further is read and shown, never kept. A
    /// failed read throws, so the kept and shown hours stay as they were (Codex R1).
    func refreshHours(_ store: any LiveHealthStore, _ metric: LiveMetric, day: Date, now: Date, calendar: Calendar) async throws -> [LivePoint] {
        let begun = epoch
        let start = calendar.startOfDay(for: day)
        let end = calendar.date(byAdding: .day, value: 1, to: start) ?? now
        let stop = min(end, now)
        let read = stop > start ? try await store.points(metric, from: start, to: stop, every: .hour).filter { $0.start >= start && $0.start < end } : []
        try Task.checkCancellation()
        guard begun == epoch else { return read }
        let week = calendar.date(byAdding: .day, value: -Self.week, to: calendar.startOfDay(for: now)) ?? start
        let others = (keptHours(metric, calendar: calendar) ?? []).filter { $0.start < start || $0.start >= end }
        let file = KeptHours(zone: calendar.timeZone.identifier, points: (others + read).filter { $0.start >= week }.sorted { $0.start < $1.start })
        hours[metric] = file
        write(file, to: Self.hoursFile(metric))
        return read
    }

    // MARK: Sleep

    /// The kept sleep, grouped into nights in `calendar`, or nil when none is kept yet.
    func keptNights(calendar: Calendar) -> [SleepNight]? {
        loadSleep().map { LiveMaths.nights($0.segments, calendar: calendar) }
    }

    /// Brings the kept sleep up to date (samples added or removed by id since the kept anchor;
    /// every sample from 2014 the first time) and returns its nights.
    func refreshNights(_ store: any LiveHealthStore, now: Date, calendar: Calendar) async throws -> [SleepNight] {
        let begun = epoch
        let segments: [SleepSegment]
        let anchor: Data?
        let kept = loadSleep()
        var change: LiveChanges?
        if let keptAnchor = kept?.anchor {
            let read = try await store.changes(.sleep, after: keptAnchor, from: nil)
            if !read.more { change = read }
        }
        if let kept, let change {
            let gone = Set(change.deleted + change.segments.compactMap(\.uuid))
            segments = kept.segments.filter { !gone.contains($0.uuid ?? "") } + change.segments.filter { $0.start >= Self.floor }
            anchor = change.anchor ?? kept.anchor
        } else {
            let all = try await store.changes(.sleep, after: nil, from: Self.floor)
            segments = all.segments
            anchor = all.anchor
        }
        try Task.checkCancellation()
        if begun == epoch {
            if segments.isEmpty {
                remove(.sleep)
            } else {
                let file = KeptSleep(anchor: anchor, segments: segments)
                sleep = file
                write(file, to: Self.sleepFile)
            }
        }
        return LiveMaths.nights(segments, calendar: calendar)
    }

    // MARK: Removal

    /// Health holds none of `metric`: its kept history and hours go (AC2).
    func remove(_ metric: LiveMetric) {
        epoch += 1
        if metric == .sleep {
            sleep = nil
            delete(Self.sleepFile)
        } else {
            days[metric] = nil
            hours[metric] = nil
            delete(Self.daysFile(metric))
            delete(Self.hoursFile(metric))
        }
    }

    /// The files of a metric the app no longer shows (heart rate, Brad dropped its card in
    /// US-73 round 4): deleted where a phone still has them.
    static let dropped = ["history-heartRate.json", "hours-heartRate.json"]

    func forgetDropped() {
        guard let folder else { return }
        for name in Self.dropped where (try? Data(contentsOf: folder.appending(path: name))) != nil { delete(name) }
    }

    /// "Delete all my data" or an access reset: every history goes (AC2).
    func removeAll() {
        for metric in LiveMetric.allCases { remove(metric) }
    }

    // MARK: Files

    private static let sleepFile = "history-sleep.json"
    private static func daysFile(_ metric: LiveMetric) -> String { "history-\(metric.rawValue).json" }
    private static func hoursFile(_ metric: LiveMetric) -> String { "hours-\(metric.rawValue).json" }

    private struct KeptDays: Codable {
        static let current = 2
        var version = current
        /// The time zone the days were read in: another zone reads them all again (adversary R4).
        let zone: String
        let oldest: Date
        let anchor: Data?
        let points: [LivePoint]
    }

    private struct KeptHours: Codable {
        static let current = 2
        var version = current
        let zone: String
        let points: [LivePoint]
    }

    private struct KeptSleep: Codable {
        static let current = 2
        var version = current
        let anchor: Data?
        let segments: [SleepSegment]
    }

    private func loadDays(_ metric: LiveMetric) -> KeptDays? {
        if let cached = days[metric] { return cached }
        let file = read(KeptDays.self, from: Self.daysFile(metric)).flatMap { $0.version == KeptDays.current ? $0 : nil }
        days[metric] = file
        return file
    }

    private func loadHours(_ metric: LiveMetric) -> KeptHours? {
        if let cached = hours[metric] { return cached }
        let file = read(KeptHours.self, from: Self.hoursFile(metric)).flatMap { $0.version == KeptHours.current ? $0 : nil }
        hours[metric] = file
        return file
    }

    private func loadSleep() -> KeptSleep? {
        if let sleep { return sleep }
        sleep = read(KeptSleep.self, from: Self.sleepFile).flatMap { $0.version == KeptSleep.current ? $0 : nil }
        return sleep
    }

    /// A missing, damaged or other-version file is no file.
    private func read<T: Decodable>(_ type: T.Type, from name: String) -> T? {
        guard let folder, let data = try? Data(contentsOf: folder.appending(path: name)) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    /// Atomic, readable after the first unlock; never on the main thread.
    private func write<T: Encodable>(_ value: T, to name: String) {
        guard let folder, let data = try? JSONEncoder().encode(value) else { return }
        counted()
        try? data.write(to: folder.appending(path: name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func delete(_ name: String) {
        guard let folder else { return }
        counted()
        try? FileManager.default.removeItem(at: folder.appending(path: name))
    }

    private func counted() {
        writes += 1
        if Thread.isMainThread { writesOnMain += 1 }
        dispatchPrecondition(condition: .notOnQueue(.main))
    }
}
