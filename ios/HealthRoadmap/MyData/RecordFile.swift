import Foundation

/// The record's file on the phone (US-25 AC4, D5): where it lives, how it is written,
/// and the engine steps that read and write it. RecordStore decides when; this file
/// says how. The web twin is widget-src/src/storage/local-storage-adapter.ts.
extension RecordStore {
    /// The record's file in the app's folder.
    nonisolated static func file(in folder: URL) -> URL {
        folder.appending(path: "health-roadmap.json")
    }

    /// The folder the app keeps the record in, made on first use and marked for iOS
    /// to leave out of iCloud and computer backups (Brad 2026-10-21). The mark is on
    /// the folder, not the file: every save replaces the file, and a mark on it would
    /// go with the old copy.
    nonisolated static func appFolder(in base: URL = .applicationSupportDirectory) throws -> URL {
        var folder = base.appending(path: "Record", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try folder.setResourceValues(values)
        return folder
    }

    /// This install's id, for the record's `meta.lastDeviceId`. Kept in the record's folder,
    /// which backups leave out, so a phone restored from a backup gets a new id and never
    /// writes a shared cloud record as the old phone (D5).
    nonisolated static func deviceId(in folder: URL) throws -> String {
        let file = folder.appending(path: "device-id")
        if let id = try? String(contentsOf: file, encoding: .utf8), id.hasPrefix("ios-") { return id }
        let id = "ios-" + UUID().uuidString.lowercased()
        try write(id, to: file)
        return id
    }

    /// Atomic, so a crash leaves the old record or the new one, never half of each.
    /// Encrypted by data protection until the phone is first unlocked after a restart:
    /// the strictest class (locked whenever the phone is) would fail when iOS
    /// pre-launches the app before the user unlocks, and lock them out of their record.
    nonisolated static func write(_ json: String, to file: URL) throws {
        try Data(json.utf8).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// The first record: written whole beside the file, then moved into place. The move
    /// fails if a file is already there, so a first record never replaces one, and a
    /// crash leaves no half-written record that would lock the app out of saving.
    nonisolated static func create(_ json: String, at file: URL) throws {
        let staged = file.deletingLastPathComponent().appending(path: ".\(UUID().uuidString).json")
        try write(json, to: staged)
        do {
            try FileManager.default.moveItem(at: staged, to: file)
        } catch {
            try? FileManager.default.removeItem(at: staged)
            throw error
        }
    }
}

/// What the phone's file holds, as RecordStore shows it.
struct PhoneLoad: Sendable {
    let record: String
    /// My data and the plan; nil when it cannot be read.
    let drawn: HealthEngine.Drawn?
    /// Why it cannot be read; the app then writes nothing.
    let problem: String?
}

/// What one edit to the phone's file did.
enum PhoneApply: Sendable {
    case refused(EditOutcome)
    /// The edit changed nothing, so nothing was written.
    case unchanged
    case saved(record: String, drawn: HealthEngine.Drawn)
}

/// RecordStore's engine work and disk writes, on the engine's queue.
extension HealthEngine {
    /// Reads the phone's file, or starts a first record when there is none.
    func loadPhone(_ file: URL, deviceId: String, units: String) throws -> PhoneLoad {
        let record: String
        // The plain path: `path()` percent-encodes, and "Application Support" has a space.
        if FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) {
            do {
                record = try String(contentsOf: file, encoding: .utf8)
            } catch {
                return PhoneLoad(record: "", drawn: nil, problem: "Your saved record could not be opened, so nothing will be saved over it. \(error.localizedDescription)")
            }
        } else {
            record = try newRecord(now: .now, deviceId: deviceId)
            try RecordStore.create(record, at: file)
        }
        do {
            return PhoneLoad(record: record, drawn: try screen(recordJSON: record, now: .now, deviceId: deviceId, units: units), problem: nil)
        } catch {
            // A damaged file, or one a newer app wrote: keep it as it is for a later fix.
            return PhoneLoad(record: record, drawn: nil, problem: "Your saved record could not be read, so nothing will be saved over it. \(error.localizedDescription)")
        }
    }

    /// My data and the plan for `record`, drawn first, then the record written: one that cannot be
    /// drawn is never written. `marking`: set the pending marker before the write, in
    /// this same step, so an app killed between the two never leaves an unmarked edit;
    /// a refused write puts back the generation it found (none, or the earlier one an
    /// opening session holds and can still clear).
    func drawAndWrite(_ record: String, units: String, to file: URL, marking: PhoneFiles?, deviceId: String) throws -> Drawn {
        let shown = try screen(recordJSON: record, now: .now, deviceId: deviceId, units: units)
        let before = marking?.pending("get") ?? 0
        let generation = marking?.pending("set") ?? 0
        do {
            try RecordStore.write(record, to: file)
        } catch {
            marking?.restore(before, ifStill: generation)
            throw error
        }
        return shown
    }

    /// One edit to the phone's file: the engine's write rules, My data and the plan in `shownIn`
    /// (the per-test units in force after it), then the atomic write.
    func applyOnPhone(_ edit: RecordEdit, to record: String, units: String, shownIn: String, file: URL, marking: PhoneFiles?, deviceId: String) throws -> PhoneApply {
        let outcome = try apply(edit, to: record, now: .now, deviceId: deviceId, units: units)
        guard outcome.ok, let next = outcome.record else { return .refused(outcome) }
        if next == record { return .unchanged }
        return .saved(record: next, drawn: try drawAndWrite(next, units: shownIn, to: file, marking: marking, deviceId: deviceId))
    }
}
