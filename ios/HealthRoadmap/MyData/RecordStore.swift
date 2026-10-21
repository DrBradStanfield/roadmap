import Foundation
import Observation

/// The user's record, one `health-roadmap.json` in the app's own storage
/// (US-25 AC4; the web keeps the same file in the user's cloud or the browser).
/// Every change goes through the engine's write rules, then to disk, and only
/// then to the screen. The web twin is widget-src/src/storage/roadmap-store.ts.
@MainActor
@Observable
final class RecordStore {
    enum ApplyResult: Equatable {
        case saved
        /// Nothing changed. `existingId` names the row that already holds that day.
        case refused(message: String, existingId: String?)
    }

    /// The record as stored, JSON text.
    private(set) var recordJSON: String
    /// What My data shows; nil while the record cannot be read.
    private(set) var myData: MyData?
    /// Why the record cannot be read, if it cannot. The app then writes nothing.
    private(set) var problem: String?
    /// While a cloud record is open (US-25 AC11): the erase the screen shows. Every
    /// edit then goes through the engine's session, which refuses one made for
    /// another erase. Nil: the record is the phone's file, written here.
    private(set) var cloudErase: String?
    /// The engine session the cloud record came from.
    private var cloudSession: Int?
    /// Told after each edit: in the cloud, that a save is on its way; on the
    /// phone, that the file moved (CloudSync marks it for the cloud then).
    var onEdit: (() -> Void)?
    /// Moves each time "Delete all my data" erases the record here (US-25 AC16),
    /// so a view holding health data outside the record, the open chat, drops it.
    private(set) var erasures = 0

    /// What the screen showed when an edit began: the erase it was at (nil on the
    /// phone's file) and its units. A sheet pins it as it opens (`pinsRecord`),
    /// so a value typed there is checked against the record the user saw, not
    /// one a sync brought in since (US-25 AC11; review R1, R2).
    struct Screen: Equatable {
        let erase: String?
        let units: String
    }
    private var pinned: Screen?
    private var pins = 0

    var screen: Screen {
        Screen(erase: cloudErase, units: myData?.unitSystem ?? "si")
    }

    /// A sheet that edits the record opened.
    func pinScreen() {
        if pins == 0 { pinned = screen }
        pins += 1
    }

    /// That sheet closed.
    func unpinScreen() {
        pins = max(0, pins - 1)
        if pins == 0 { pinned = nil }
    }

    private let engine: HealthEngine
    /// A downloaded engine on trial (US-25 AC18): My data confirms it once it shows the record.
    var engineTrial: EngineTrial? { engine.trial }
    /// Where the record is kept.
    let file: URL
    let deviceId: String

    init(folder: URL, engine: HealthEngine, deviceId: String) throws {
        self.engine = engine
        self.deviceId = deviceId
        file = folder.appending(path: "health-roadmap.json")
        recordJSON = ""
        try loadPhoneRecord()
    }

    /// Reads the phone's file, or starts a first record when there is none.
    private func loadPhoneRecord() throws {
        problem = nil
        myData = nil
        // The plain path: `path()` percent-encodes, and "Application Support" has a space.
        if FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) {
            do {
                recordJSON = try String(contentsOf: file, encoding: .utf8)
            } catch {
                recordJSON = ""
                problem = "Your saved record could not be opened, so nothing will be saved over it. \(error.localizedDescription)"
                return
            }
        } else {
            recordJSON = try engine.newRecord(now: .now, deviceId: deviceId)
            try Self.create(recordJSON, at: file)
        }
        do {
            myData = try engine.myData(recordJSON: recordJSON, now: .now, deviceId: deviceId)
        } catch {
            // A damaged file, or one a newer app wrote: keep it as it is for a later fix.
            problem = "Your saved record could not be read, so nothing will be saved over it. \(error.localizedDescription)"
        }
    }

    // MARK: Cloud (US-25 AC11)

    /// Show the cloud record the engine opened or took in, and send edits to it.
    /// A record the screen cannot draw is not shown; the last good one stays.
    func showCloud(_ view: HealthEngine.CloudView) {
        guard let shown = try? engine.myData(recordJSON: view.record, now: .now, deviceId: deviceId) else { return }
        recordJSON = view.record
        myData = shown
        problem = nil
        cloudErase = view.erase
        cloudSession = view.session
    }

    /// Back to the phone's own file (Disconnect, or a cloud that could not open).
    func showPhone() {
        cloudErase = nil
        do {
            try loadPhoneRecord()
        } catch {
            problem = "Your record on this iPhone could not be opened. \(error.localizedDescription)"
        }
    }

    // MARK: Erase (US-25 AC16)

    /// The phone's own file, erased by the engine (DataEraser): written, then shown.
    func showErased(_ erased: String) throws {
        let shown = try engine.myData(recordJSON: erased, now: .now, deviceId: deviceId)
        try Self.write(erased, to: file)
        recordJSON = erased
        myData = shown
        problem = nil
        erasures += 1
    }

    /// The cloud record, erased by the engine's session: shown like any record it sends.
    func showErased(_ view: HealthEngine.CloudView) {
        showCloud(view)
        erasures += 1
    }

    /// The phone's file as text, nil when there is none (the engine's device mirror).
    func phoneText() throws -> String? {
        guard FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) else { return nil }
        return try String(contentsOf: file, encoding: .utf8)
    }

    /// Writes the phone's file, atomically, for the engine's device mirror.
    func writePhone(_ text: String) throws {
        try Self.write(text, to: file)
    }

    func removePhone() {
        try? FileManager.default.removeItem(at: file)
    }

    /// The folder the app keeps the record in, made on first use and marked for iOS
    /// to leave out of iCloud and computer backups (Brad 2026-10-21). The mark is on the folder, not the file: every save
    /// replaces the file, and a mark on it would go with the old copy.
    static func appFolder(in base: URL = .applicationSupportDirectory) throws -> URL {
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
    static func deviceId(in folder: URL) throws -> String {
        let file = folder.appending(path: "device-id")
        if let id = try? String(contentsOf: file, encoding: .utf8), id.hasPrefix("ios-") { return id }
        let id = "ios-" + UUID().uuidString.lowercased()
        try write(id, to: file)
        return id
    }

    /// A typed number, read by the web's rule; nil if it is not a plain decimal.
    func number(_ text: String) -> Double? {
        (try? engine.number(from: text)) ?? nil
    }

    /// Every value recorded for one metric (US-25 AC9); nil while the record cannot be read.
    func history(for metric: String) -> MetricHistory? {
        guard problem == nil else { return nil }
        return try? engine.history(recordJSON: recordJSON, metric: metric, now: .now, deviceId: deviceId)
    }

    func apply(_ edit: RecordEdit) -> ApplyResult { apply(edit, as: pinned ?? screen) }

    /// An edit no sheet opened, such as an Apple Health import (D6): checked against
    /// the record as it is now, never against a sheet's pin, so an open sheet cannot
    /// make it refuse. It still takes the same path: in the cloud, the session, the
    /// merge and the erase guard.
    func applyNow(_ edit: RecordEdit) -> ApplyResult { apply(edit, as: screen) }

    private func apply(_ edit: RecordEdit, as seen: Screen) -> ApplyResult {
        // An erase taken in, or sync turned on or off, since the sheet opened.
        // The sheet keeps refusing until it closes: it still shows the old record,
        // its unit and the typed number, so a second Save would store that number
        // in a record or units it never showed (re-check R1).
        guard seen.erase == cloudErase else {
            return .refused(message: "Your record changed while this was open, so this was not saved. Close this and enter the value again.", existingId: nil)
        }
        if let erase = seen.erase { return applyInCloud(edit, erase: erase, units: seen.units) }
        if let problem { return .refused(message: problem, existingId: nil) }
        do {
            let outcome = try engine.apply(edit, to: recordJSON, now: .now, deviceId: deviceId)
            guard outcome.ok, let next = outcome.record else {
                return .refused(message: outcome.message ?? "That could not be saved.", existingId: outcome.existingId)
            }
            // An edit that changed nothing (an Apple Health batch with nothing new) writes nothing.
            if next == recordJSON { return .saved }
            let shown = try engine.myData(recordJSON: next, now: .now, deviceId: deviceId)
            try Self.write(next, to: file)
            recordJSON = next
            myData = shown
            onEdit?()
            return .saved
        } catch {
            return .refused(message: error.localizedDescription, existingId: nil)
        }
    }

    /// Through the engine's open session: the save loop sends it to the cloud.
    private func applyInCloud(_ edit: RecordEdit, erase: String, units: String) -> ApplyResult {
        do {
            let outcome = try engine.cloudEdit(edit, erase: erase, units: units, now: .now)
            guard outcome.ok, let next = outcome.record, let nextErase = outcome.erase else {
                return .refused(message: outcome.message ?? "That could not be saved.", existingId: outcome.existingId)
            }
            if next == recordJSON { return .saved }
            showCloud(HealthEngine.CloudView(record: next, erase: nextErase, session: cloudSession ?? 0))
            onEdit?()
            return .saved
        } catch {
            return .refused(message: error.localizedDescription, existingId: nil)
        }
    }

    /// Atomic, so a crash leaves the old record or the new one, never half of each.
    /// Encrypted by data protection until the phone is first unlocked after a restart:
    /// the strictest class (locked whenever the phone is) would fail when iOS
    /// pre-launches the app before the user unlocks, and lock them out of their record.
    private static func write(_ json: String, to file: URL) throws {
        try Data(json.utf8).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// The first record: written whole beside the file, then moved into place. The move
    /// fails if a file is already there, so a first record never replaces one, and a
    /// crash leaves no half-written record that would lock the app out of saving.
    private static func create(_ json: String, at file: URL) throws {
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
