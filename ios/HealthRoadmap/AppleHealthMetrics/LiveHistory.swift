import Foundation

/// Each US-56 page's history, kept on this iPhone so a page draws at once (AC7a; Brad
/// 2026-11-03: "store it so that we can quickly load it and we don't have to keep fetching
/// it"). One file per metric (its days) and one for sleep (its samples), beside the cards' kept
/// readings in Application Support/Apple Health: out of backups, apart from the record, so no
/// sync, export or chat summary reaches them. An actor, so reading, decoding, merging, grouping
/// nights and writing all run off the main thread; pages get only the finished arrays.
/// The first read takes the whole history, from the oldest sample (not before 2014); each later
/// one asks only from three days before the newest stored day, since today's totals and a
/// Watch's late sync change the last days. Nothing is logged.
actor LiveHistory {
    /// HealthKit began in 2014; a sample dated earlier is an importer's artifact (adversary R3).
    static let floor = Date(timeIntervalSince1970: 1_388_534_400) // 2014-01-01T00:00Z
    /// The newest days read again each time.
    static let reread = 3

    /// Where the files go; nil keeps them in memory only.
    private let folder: URL?
    private var days: [LiveMetric: KeptDays] = [:]
    private var sleep: KeptSleep?
    /// Bumped by `removeAll()`: a read begun before it is not kept.
    private var epoch = 0
    /// Set if a file was ever written on the main thread (tests).
    private(set) var wroteOnMain = false

    init(folder: URL?) {
        self.folder = folder
    }

    /// The metric's kept days, or nil when none are kept yet.
    func keptDays(_ metric: LiveMetric) -> [LivePoint]? {
        loadDays(metric)?.points
    }

    /// The kept sleep, grouped into nights in `calendar`, or nil when none is kept yet.
    func keptNights(calendar: Calendar) -> [SleepNight]? {
        loadSleep().map { LiveMaths.nights($0.segments, calendar: calendar) }
    }

    /// Reads what is new since the kept days (all of them the first time), keeps the result,
    /// and returns every day. Health holding none of the metric removes its file. Throws, and
    /// keeps what it had, when HealthKit fails or the phone is locked.
    func refreshDays(_ store: any LiveHealthStore, _ metric: LiveMetric, now: Date, calendar: Calendar) async throws -> [LivePoint] {
        let begun = epoch
        guard let first = try await store.earliest(metric) else {
            if begun == epoch { remove("history-\(metric.rawValue).json"); days[metric] = nil }
            return []
        }
        let oldest = calendar.startOfDay(for: max(first, Self.floor))
        let kept = loadDays(metric)
        let from = kept.flatMap { kept in
            kept.oldest <= oldest ? kept.points.last.flatMap { calendar.date(byAdding: .day, value: -Self.reread, to: calendar.startOfDay(for: $0.start)) } : nil
        } ?? oldest
        let read = try await store.points(metric, from: from, to: now, every: .day)
        try Task.checkCancellation()
        // Kept days before `from`, then those read from it: never one twice.
        let points = from == oldest ? read : (kept?.points ?? []).filter { $0.start < from } + read.filter { $0.start >= from }
        guard begun == epoch else { return points }
        let file = KeptDays(oldest: min(oldest, kept?.oldest ?? oldest), points: points)
        days[metric] = file
        write(file, to: "history-\(metric.rawValue).json")
        return points
    }

    /// Sleep's `refreshDays`: new samples since the kept ones (all of them the first time),
    /// grouped into nights.
    func refreshNights(_ store: any LiveHealthStore, now: Date, calendar: Calendar) async throws -> [SleepNight] {
        let begun = epoch
        guard let first = try await store.earliest(.sleep) else {
            if begun == epoch { remove(Self.sleepFile); sleep = nil }
            return []
        }
        let oldest = max(first, Self.floor)
        let kept = loadSleep()
        let from = kept.flatMap { kept in
            kept.oldest <= oldest ? kept.segments.map(\.start).max().flatMap { calendar.date(byAdding: .day, value: -Self.reread, to: $0) } : nil
        } ?? oldest
        let read = try await store.sleep(from: from, to: now)
        try Task.checkCancellation()
        // Kept samples ending by `from`, then those read that end after it: never one twice.
        let segments = (from == oldest ? [] : (kept?.segments ?? []).filter { $0.end <= from }) + read.filter { from == oldest || $0.end > from }
        if begun == epoch {
            let file = KeptSleep(oldest: min(oldest, kept?.oldest ?? oldest), segments: segments)
            sleep = file
            write(file, to: Self.sleepFile)
        }
        return LiveMaths.nights(segments, calendar: calendar)
    }

    /// "Delete all my data", access reset, or an empty Health: every history goes (AC2).
    func removeAll() {
        epoch += 1
        days = [:]
        sleep = nil
        for metric in LiveMetric.allCases { remove(metric == .sleep ? Self.sleepFile : "history-\(metric.rawValue).json") }
    }

    // MARK: Files

    private static let sleepFile = "history-sleep.json"

    private struct KeptDays: Codable {
        static let current = 1
        var version = current
        /// The first day read: a sample older than it (an import) reads the whole history again.
        let oldest: Date
        let points: [LivePoint]
    }

    private struct KeptSleep: Codable {
        static let current = 1
        var version = current
        let oldest: Date
        let segments: [SleepSegment]
    }

    private func loadDays(_ metric: LiveMetric) -> KeptDays? {
        if let cached = days[metric] { return cached }
        let file = read(KeptDays.self, from: "history-\(metric.rawValue).json").flatMap { $0.version == KeptDays.current ? $0 : nil }
        days[metric] = file
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

    /// Atomic, readable after the first unlock.
    private func write<T: Encodable>(_ value: T, to name: String) {
        guard let folder, let data = try? JSONEncoder().encode(value) else { return }
        if Thread.isMainThread { wroteOnMain = true }
        try? data.write(to: folder.appending(path: name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func remove(_ name: String) {
        guard let folder else { return }
        if Thread.isMainThread { wroteOnMain = true }
        try? FileManager.default.removeItem(at: folder.appending(path: name))
    }
}
