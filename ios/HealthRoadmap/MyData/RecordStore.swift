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
    /// Per-test units (US-25 AC17e): this phone's preference, as the web's are its browser's.
    private(set) var unitChoices = UnitChoices.saved()

    /// What the screen showed when an edit began: the erase it was at (nil on the
    /// phone's file) and its units. A sheet pins it as it opens (`pinsRecord`),
    /// so a value typed there is checked against the record the user saw, not
    /// one a sync brought in since (US-25 AC11; review R1, R2).
    struct Screen: Equatable {
        let erase: String?
        let units: String
        /// The per-test units it showed (US-25 AC17e): a typed value is read in them.
        let choices: String
    }
    private var pinned: Screen?
    private var pins = 0

    var screen: Screen {
        Screen(erase: cloudErase, units: myData?.unitSystem ?? "si", choices: unitChoices.json)
    }

    /// A sheet that edits the record opened.
    func pinScreen() {
        if pins == 0 { pinned = screen }
        pins += 1
    }

    /// A screen that stays open across several edits (onboarding) takes the record now
    /// shown as the one its next edit is checked against.
    func repinScreen() {
        if pins > 0 { pinned = screen }
    }

    /// That sheet closed.
    func unpinScreen() {
        pins = max(0, pins - 1)
        if pins == 0 { pinned = nil }
    }

    private let engine: HealthEngine
    /// A downloaded engine on trial (US-25 AC18).
    var engineTrial: EngineTrial? { engine.trial }

    /// The trial's confirm path from My data (review N1): only when the engine drew the
    /// user's record AND planned it (a plan, or health-core's PlanError), never when either threw.
    func confirmEngineTrial() {
        guard let trial = engine.trial, myData != nil,
              EngineTrial.planned(engine, recordJSON: recordJSON, deviceId: deviceId)
        else { return }
        trial.confirm()
    }
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
            myData = try engine.myData(recordJSON: recordJSON, now: .now, deviceId: deviceId, units: unitChoices.json)
        } catch {
            // A damaged file, or one a newer app wrote: keep it as it is for a later fix.
            problem = "Your saved record could not be read, so nothing will be saved over it. \(error.localizedDescription)"
        }
    }

    // MARK: Cloud (US-25 AC11)

    /// Show the cloud record the engine opened or took in, and send edits to it.
    /// A record the screen cannot draw is not shown; the last good one stays.
    func showCloud(_ view: HealthEngine.CloudView) {
        guard let shown = try? engine.myData(recordJSON: view.record, now: .now, deviceId: deviceId, units: unitChoices.json) else { return }
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
        // A fresh start: no per-test choice, published only once the erase is on disk (Codex R1).
        let shown = try engine.myData(recordJSON: erased, now: .now, deviceId: deviceId, units: UnitChoices().json)
        try Self.write(erased, to: file)
        recordJSON = erased
        myData = shown
        publish(UnitChoices())
        problem = nil
        erasures += 1
    }

    /// The cloud record, erased by the engine's session: shown like any record it sends.
    func showErased(_ view: HealthEngine.CloudView) {
        publish(UnitChoices())
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
        // A value page asks on every redraw (a sheet opening, a range picked): the engine
        // runs once per record and metric. Not observed: a cache, not state.
        let units = unitChoices.json
        if let cached = historyCache, cached.record == recordJSON, cached.metric == metric, cached.units == units { return cached.history }
        let history = try? engine.history(recordJSON: recordJSON, metric: metric, now: .now, deviceId: deviceId, units: units)
        historyCache = (recordJSON, metric, units, history)
        return history
    }

    @ObservationIgnored private var historyCache: (record: String, metric: String, units: String, history: MetricHistory?)?

    func apply(_ edit: RecordEdit) -> ApplyResult { apply(edit, as: pinned ?? screen) }

    /// The units the row for `metric` shows: its per-test choice, else the record's (AC17e).
    func units(for metric: String) -> String {
        unitChoices.system(for: metric, record: myData?.unitSystem ?? "si")
    }

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
        if let erase = seen.erase { return applyInCloud(edit, erase: erase, seen: seen) }
        if let problem { return .refused(message: problem, existingId: nil) }
        do {
            let outcome = try engine.apply(edit, to: recordJSON, now: .now, deviceId: deviceId, units: seen.choices)
            guard outcome.ok, let next = outcome.record else {
                return .refused(message: outcome.message ?? "That could not be saved.", existingId: outcome.existingId)
            }
            // An edit that changed nothing (an Apple Health batch with nothing new) writes nothing.
            if next == recordJSON { return .saved }
            // The master switch clears every choice, published only with the record it
            // changed: a failed write keeps both as they were (Codex R1).
            let choices = Self.clearsChoices(edit) ? UnitChoices() : unitChoices
            let shown = try engine.myData(recordJSON: next, now: .now, deviceId: deviceId, units: choices.json)
            try Self.write(next, to: file)
            recordJSON = next
            myData = shown
            publish(choices)
            onEdit?()
            return .saved
        } catch {
            return .refused(message: error.localizedDescription, existingId: nil)
        }
    }

    /// Through the engine's open session: the save loop sends it to the cloud.
    private func applyInCloud(_ edit: RecordEdit, erase: String, seen: Screen) -> ApplyResult {
        do {
            let outcome = try engine.cloudEdit(edit, erase: erase, units: seen.units, now: .now, choices: seen.choices)
            guard outcome.ok, let next = outcome.record, let nextErase = outcome.erase else {
                return .refused(message: outcome.message ?? "That could not be saved.", existingId: outcome.existingId)
            }
            if next == recordJSON { return .saved }
            // The session has taken the edit: the choices follow it.
            if Self.clearsChoices(edit) { publish(UnitChoices()) }
            showCloud(HealthEngine.CloudView(record: next, erase: nextErase, session: cloudSession ?? 0))
            onEdit?()
            return .saved
        } catch {
            return .refused(message: error.localizedDescription, existingId: nil)
        }
    }

    // MARK: Documents (US-52 AC13d)

    /// What filing a document did.
    enum DocumentResult: Equatable {
        /// `stored`: the original reached the cloud (nil: none was offered to one).
        /// `unstored`: held originals that still could not be stored. `stale`: the original
        /// changed or could not be read after the review, so only its text was saved.
        case saved(count: Int, stored: Bool?, unstored: Int, stale: Bool)
        case refused(String)
    }

    /// Files one reviewed document, or a lab report's original, by health-core's
    /// saveDocuments, the web's one save path. In the cloud: the original goes up first,
    /// then the rows through the engine's session, with the erase the screen showed.
    /// On the phone: a text-only row (no original), written to the file as an edit is.
    func saveDocument(extractionJSON: String, choice: DocumentChoice, original: LabFileReader.Original?) async -> DocumentResult {
        let seen = pinned ?? screen
        guard seen.erase == cloudErase else {
            return .refused("Your record changed while this was open, so this was not saved. Close this and try again.")
        }
        if seen.erase == nil, let problem { return .refused(problem) }
        let before = recordJSON
        do {
            // The engine decides whether an original is kept (only in a cloud); off-cloud
            // the file is not even read, since it would go nowhere. Read now, it must be
            // the bytes the review read (their hash), or it is left out.
            let bytes = seen.erase == nil ? nil : original?.verifiedData()
            let answer = try await engine.documentSave(
                recordJSON: seen.erase == nil ? before : "", extractionJSON: extractionJSON, choice: choice,
                original: bytes, erase: seen.erase ?? "", now: .now, deviceId: deviceId)
            guard answer.ok, let next = answer.record else { return .refused(answer.message ?? "That could not be saved.") }
            let result = DocumentResult.saved(count: answer.saved ?? 0, stored: answer.stored, unstored: answer.unstored ?? 0, stale: answer.stale ?? false)
            if let erase = seen.erase {
                // The engine's session took it; the screen follows unless it has moved on to another record.
                guard cloudErase == erase, let nextErase = answer.erase else { return result }
                if next != recordJSON {
                    showCloud(HealthEngine.CloudView(record: next, erase: nextErase, session: cloudSession ?? 0))
                    onEdit?()
                }
                return result
            }
            guard try commitPhoneDocument(next, over: before) else {
                return .refused("Your record changed while this was saving, so it was not saved. Save again.")
            }
            return result
        } catch {
            return .refused(error.localizedDescription)
        }
    }

    /// A document save's record, onto the phone's file: written only over the record the
    /// save began from (`before`), never over an edit made while it ran. False when refused.
    func commitPhoneDocument(_ next: String, over before: String) throws -> Bool {
        guard cloudErase == nil, recordJSON == before else { return false }
        if next != recordJSON {
            let shown = try engine.myData(recordJSON: next, now: .now, deviceId: deviceId, units: unitChoices.json)
            try Self.write(next, to: file)
            recordJSON = next
            myData = shown
            onEdit?()
        }
        return true
    }

    // MARK: Per-test units (US-25 AC17e)

    /// One test to the other units, as the web's unit chip does. Back to the record's
    /// units drops the choice; nothing is written to the record.
    func switchUnits(for row: MyData.Row, to system: String) {
        guard row.switchable == true, let data = myData else { return }
        let choices = unitChoices.setting(row.metric, to: system == data.unitSystem ? nil : system)
        // Drawn first: a choice the screen cannot show is not kept, so labels and reading agree.
        guard let shown = try? engine.myData(recordJSON: recordJSON, now: .now, deviceId: deviceId, units: choices.json) else { return }
        myData = shown
        publish(choices)
    }

    /// The master switch clears every per-test choice, as the web's does, on the phone's
    /// file and in the cloud alike.
    private static func clearsChoices(_ edit: RecordEdit) -> Bool {
        if case .units = edit { true } else { false }
    }

    /// The choices now in force, kept on the phone. An erase and the master switch publish
    /// none: a fresh start whose onboarding asks in the record's units (adversary R1).
    private func publish(_ choices: UnitChoices) {
        guard choices != unitChoices else { return }
        unitChoices = choices
        unitChoices.save()
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
