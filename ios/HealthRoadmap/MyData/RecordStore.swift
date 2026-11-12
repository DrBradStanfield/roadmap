import Foundation
import Observation

/// The user's record, one `health-roadmap.json` in the app's own storage
/// (US-25 AC4; the web keeps the same file in the user's cloud or the browser).
/// Every change goes through the engine's write rules, then to disk, and only
/// then to the screen. The engine and the disk run off the main thread; changes
/// land one at a time, in the order they were asked for (`chain`).
/// How the file is read and written: RecordFile.swift. The web twin is
/// widget-src/src/storage/roadmap-store.ts.
@MainActor
@Observable
final class RecordStore {
    enum ApplyResult: Equatable, Sendable {
        /// `healthRecords`: what a Health Records batch did when it changed the record (US-72).
        case saved(healthRecords: HealthRecordCounts? = nil)
        /// Nothing changed. `existingId` names the row that already holds that day.
        case refused(message: String, existingId: String?)
    }

    /// The record as stored, JSON text.
    var recordJSON: String { didSet { if recordJSON != oldValue { revision += 1 } } }
    /// My health's rows and the plan, from one engine call, so the two always show the same record
    /// (US-25 AC2); nil while the record cannot be read.
    private(set) var drawn: HealthEngine.Drawn?
    /// My health's rows and forms; nil while the record cannot be read.
    var myData: MyData? { drawn?.myData }
    /// My health's plan; nil while the record cannot be read.
    var plan: PlanState? { drawn?.plan }
    /// The plan's cards by topic, from the same call (US-73 AC3).
    var topics: TopicLayout? { drawn?.topics }
    /// Why the record cannot be read, if it cannot. The app then writes nothing.
    var problem: RecordProblem?
    // Source union (next PR) replaces the phone/cloud fields: cloudErase, cloudSession,
    // cloudName, cloudAccount and marksPending here, and recordJSON above. Their readers
    // and writers live in RecordStore+Source.swift.
    /// While a cloud record is open (US-25 AC11): the erase the screen shows. Every
    /// edit then goes through the engine's session, which refuses one made for
    /// another erase. Nil: the record is the phone's file, written here.
    var cloudErase: String?
    /// The engine session the cloud record came from.
    var cloudSession: Int?
    /// Told after each edit: in the cloud, that a save is on its way; on the
    /// phone, that the file moved (CloudSync marks it for the cloud then).
    var onEdit: (() -> Void)?
    /// While a cloud is connected but its record is not open: the marker a phone edit
    /// sets, in the same engine step that writes it, so the next open merges it up
    /// (US-09 AC4). Read when the edit's turn comes: an edit asked for before a first
    /// connect, landing after it, is marked too. Set by CloudSync; nil with no cloud.
    @ObservationIgnored var marksPending: PhoneFiles?
    /// The connected cloud's provider and account, from CloudSync; `draw` sets `cloudName` from it with `cloudErase`.
    @ObservationIgnored var cloudAccount: String?
    @ObservationIgnored var cloudName: String?
    /// Moves each time "Delete all my data" erases the record here (US-25 AC16),
    /// so a view holding health data outside the record, the open chat, drops it.
    private(set) var erasures = 0 { didSet { forgetCharts() } }
    /// Per-test units (US-25 AC17e): this phone's preference, as the web's are its browser's.
    private(set) var unitChoices = UnitChoices.saved() { didSet { if unitChoices != oldValue { revision += 1; forgetCharts() } } }
    /// The person's own saves (US-57 AC9): a sheet's edit or a lab report's values that
    /// changed the record, never an Apple Health import (`applyNow`) or a units choice.
    /// The cloud prompt counts them.
    var ownSaves = 0
    /// Moves whenever the record or the per-test units change: a page keyed on it asks again.
    private(set) var revision = 0
    /// Moves with every screen drawn: each edit, and a redraw of the same record (a new day, a
    /// storefront switch), which moves no `revision`. My health builds its page on it (review round 2).
    private(set) var draws = 0
    /// Where the record is kept.
    let file: URL
    let deviceId: String
    let engine: HealthEngine  // not private: RecordStore+Documents.swift reads it

    /// What the screen showed when an edit began: the erase it was at (nil on the
    /// phone's file) and its units. A sheet pins it as it opens (`pinsRecord`),
    /// so a value typed there is checked against the record the user saw, not
    /// one a sync brought in since (US-25 AC11; review R1, R2).
    struct Screen: Equatable {
        let erase: String?
        let units: String
        /// The per-test units it showed (US-25 AC17e): a typed value is read in them.
        let choices: String
        /// Lp(a)'s unit it showed (US-05 AC2): the record's, so another device can change it.
        let lpaUnit: String

        /// The same screen once its sheet has chosen Lp(a)'s unit (US-25 AC20).
        func showing(lpaUnit: String) -> Screen {
            Screen(erase: erase, units: units, choices: choices, lpaUnit: lpaUnit)
        }
    }
    private(set) var pinned: Screen?  // read by save all's stop rule (US-52 AC8b)
    private var pins = 0
    /// The last change asked for: each waits for the one before (`chain`). Released when
    /// it finishes, so its result is not kept; nothing is left to wait for then.
    @ObservationIgnored private var tail: (@MainActor () async -> Void)?
    @ObservationIgnored private var chained = 0
    /// The engine's stamp on the cloud record shown: one handed over earlier is stale.
    @ObservationIgnored var shownOrder = 0

    /// Unit switches asked for and not yet landed, per-test or the master one. While one
    /// is pending, a sheet would pin the old units and label itself from the new row:
    /// entry waits (AC17e).
    var unitSwitches = 0

    struct Stamp: Equatable {
        let revision: Int
        let draws: Int?
    }

    struct KeptHistory {
        let stamp: Stamp
        let chart: ChartData?
    }
    var histories: [String: KeptHistory] = [:]
    /// A history the engine is reading, for the stamp it was asked at.
    @ObservationIgnored var reading: [String: (stamp: Stamp, task: Task<ChartData?, Never>)] = [:]

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

    // MARK: Opening

    /// The store, with the phone's file read and drawn by the engine first: at launch,
    /// before the first screen, waited for once, off the main thread (US-25 AC21).
    static func open(folder: URL, engine: HealthEngine, deviceId: String) async throws -> RecordStore {
        let units = UnitChoices.saved().json
        let loaded = try await engine.loadPhone(file(in: folder), deviceId: deviceId, units: units)
        return RecordStore(folder: folder, engine: engine, deviceId: deviceId, loaded: loaded)
    }

    /// `loaded`: the phone's file as the engine read it (`open`).
    init(folder: URL, engine: HealthEngine, deviceId: String, loaded: PhoneLoad) {
        self.engine = engine
        self.deviceId = deviceId
        file = Self.file(in: folder)
        recordJSON = ""
        show(loaded)
    }

    /// Runs `job` after every change asked for before it, so two quick edits land in
    /// the order they were made. Every change to the record goes through here.
    @discardableResult
    func chain<T: Sendable>(_ job: @escaping @MainActor () async -> T) -> Task<T, Never> {
        let previous = tail
        chained += 1
        let turn = chained
        let task = Task { @MainActor in
            await previous?()
            let result = await job()
            if self.chained == turn { self.tail = nil }
            return result
        }
        tail = { _ = await task.value }
        return task
    }

    /// My data and the plan, from one engine call, together. A downloaded engine on trial
    /// is proven once it has drawn the user's own record and planned it (a plan, or
    /// health-core's PlanError), never when the plan threw: the failure the trial exists
    /// to catch (US-25 AC18, review R5).
    func display(_ drawn: HealthEngine.Drawn?) {
        self.drawn = drawn
        draws += 1
        if drawn?.plan.planned == true { engine.trial?.confirm() }
    }

    /// Shows what the phone's file holds.
    func show(_ loaded: PhoneLoad) {
        recordJSON = loaded.record
        display(loaded.drawn)
        problem = loaded.problem
    }

    /// The same record drawn again at `now` (Codex R1): the plan reads the time (ages,
    /// screening due dates, and minor status, which turns at midday UTC, not local midnight,
    /// so no calendar-day check can stand in). Called each time the app becomes active and at
    /// midnight while it is; a draw takes about a millisecond. In line with every change
    /// (`chain`); nothing when no record is drawn.
    @discardableResult
    func redraw(now: Date = .now) -> Task<Void, Never> {
        chain {
            guard self.drawn != nil,
                  let shown = try? await self.engine.screen(recordJSON: self.recordJSON, now: now, deviceId: self.deviceId, units: self.unitChoices.json)
            else { return }
            self.display(shown)
        }
    }

    /// The App Store storefront's country (US-61, `AppStoreCountry`): a change draws the
    /// record again, so the plan's supplement cards gain or lose Dr Brad's products.
    func follow(storefrontIsUS isUS: Bool) async {
        guard await engine.storefrontIsUS != isUS else { return }
        await engine.useStorefront(isUS: isUS)
        await redraw().value
    }

    // MARK: Erase (US-25 AC16)

    /// What erasing the phone's own file did.
    enum PhoneErase: Equatable, Sendable {
        /// The record could not be read: nothing was erased.
        case unreadable
        /// Erased, but the phone refused the write. `chatErased`: the chat history was.
        case notWritten(String, chatErased: Bool)
        case erased(chatErased: Bool)
    }

    /// "Delete all my data" on the phone's own file (DataEraser), as one step in line:
    /// the record is read, erased by the engine, the chat tombstones kept (`keepChat`,
    /// given the engine's tombstoned chat file), then the erase written and shown. An
    /// edit asked for meanwhile lands after it, never under it (Codex R1). `keepChat` runs
    /// on the engine's queue, where the chat history's own read-modify-writes run, so
    /// neither lands between the other's read and write (ChatHistoryStore).
    func erasePhone(historyJSON: String?, keepChat: @escaping @Sendable (_ chatHistory: String?, _ engineErased: Bool) -> Bool) async -> PhoneErase {
        await chain {
            guard self.problem == nil else { return .unreadable }
            let (file, deviceId) = (self.file, self.deviceId)
            // The file is read on the engine's queue, in the same step as the erase.
            guard let result = try? await self.engine.perform({ engine -> HealthEngine.PhoneErase? in
                guard let record = try? Self.phoneText(file) else { return nil }
                return try engine.eraseOnPhone(recordJSON: record, historyJSON: historyJSON, now: .now, deviceId: deviceId)
            }) else { return .unreadable }
            let chatErased = await self.engine.perform { _ in keepChat(result.chatHistory, result.chatErased) }
            do {
                // A fresh start: no per-test choice, published only once the erase is on disk (Codex R1).
                // Marked and counted as any phone edit is: a connect in flight that lifted
                // the pre-erase file opens again and merges the erase in, whose higher
                // eraseEpoch wins (US-09 AC23).
                let shown = try await self.engine.drawAndWrite(result.record, units: UnitChoices().json, to: self.file, marking: self.marksPending, deviceId: self.deviceId)
                self.recordJSON = result.record
                self.display(shown)
                self.publish(UnitChoices())
                self.problem = nil
                self.erasures += 1
                self.onEdit?()
                return .erased(chatErased: chatErased)
            } catch {
                return .notWritten(error.localizedDescription, chatErased: chatErased)
            }
        }.value
    }

    /// The cloud record, erased by the engine's session: shown like any record it sends.
    @discardableResult
    func showErased(_ view: HealthEngine.CloudView) -> Task<Void, Never> {
        chain {
            // A fresh start: no per-test choice, published only with the erase drawn (adversary R4).
            await self.draw(view, in: UnitChoices())
            self.erasures += 1
        }
    }

    /// The phone's file as text, nil when there is none.
    nonisolated private static func phoneText(_ file: URL) throws -> String? {
        guard FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) else { return nil }
        return try String(contentsOf: file, encoding: .utf8)
    }

    /// Drops every kept chart and running read, on an erase or a unit change: a page opened
    /// after it never shows the earlier values, only one read for now (US-25 AC21, adversary R1).
    func forgetCharts() {
        histories = [:]
        reading = [:]
    }

    /// One edit, checked against the record the screen showed when it was asked for:
    /// the sheet's pin, taken now, before anything waits.
    /// `captured`: the screen a sheet was opened on, taken with the row it shows (the tap).
    func apply(_ edit: RecordEdit, as captured: Screen? = nil) async -> ApplyResult {
        let seen = captured ?? pinned ?? screen
        // The master units switch holds entry while it lands, as a per-test one does.
        let switching = Self.clearsChoices(edit)
        if switching { unitSwitches += 1 }
        let (result, changed) = await chain {
            defer { if switching { self.unitSwitches -= 1 } }
            let before = self.recordJSON
            return (await self.applyInTurn(edit, as: seen), self.recordJSON != before)
        }.value
        // An edit that changed nothing is not a save (review R5).
        if changed, !switching { ownSaves += 1 }
        // A page opened after the master units switch never shows the old units (adversary R1).
        if changed, switching { forgetCharts() }
        return result
    }

    /// An edit no sheet opened, such as an Apple Health import (D6): checked against
    /// the record as it is now, never against a sheet's pin, so an open sheet cannot
    /// make it refuse. It still takes the same path: in the cloud, the session, the
    /// merge and the erase guard.
    /// Its turn in line decides "now": the screen is read when the edits before it have landed.
    /// An Apple Health batch, on the record it was read from: `applyNow(_:on:)`.
    func applyNow(_ edit: RecordEdit) async -> ApplyResult {
        await chain { await self.applyInTurn(edit, as: self.screen) }.value
    }

    func applyInTurn(_ edit: RecordEdit, as seen: Screen) async -> ApplyResult {
        // An erase taken in, or sync turned on or off, since the sheet opened.
        // The sheet keeps refusing until it closes: it still shows the old record,
        // its unit and the typed number, so a second Save would store that number
        // in a record or units it never showed (re-check R1).
        guard seen.erase == cloudErase else {
            return .refused(message: "Your record changed while this was open, so this was not saved. Close this and enter the value again.", existingId: nil)
        }
        if let erase = seen.erase { return await applyInCloud(edit, erase: erase, seen: seen) }
        if let problem { return .refused(message: problem.words, existingId: nil) }
        // A number read in units the record no longer has, as the cloud session refuses it
        // (cloud.ts dependsOnUnits): the master switch landed while the sheet was open.
        if Self.dependsOnUnits(edit), seen.units != (myData?.unitSystem ?? "si") {
            return .refused(message: "Your units changed while this was open, so this was not saved. Close this and enter the value again.", existingId: nil)
        }
        // Lp(a)'s unit is the record's: a number typed in another is never saved in this one.
        if seen.lpaUnit != screen.lpaUnit, await readsLpa(edit) {
            return .refused(message: "Your Lp(a) unit changed while this was open, so this was not saved. Close this and enter the value again.", existingId: nil)
        }
        do {
            // The master switch clears every choice, published only with the record it
            // changed: a failed write keeps both as they were (Codex R1).
            let choices = Self.clearsChoices(edit) ? UnitChoices() : unitChoices
            // One engine call: the edit, My data and the atomic write, off the main thread.
            let answer = try await engine.applyOnPhone(edit, to: recordJSON, units: seen.choices, shownIn: choices.json, file: file, marking: marksPending, deviceId: deviceId)
            switch answer {
            case .refused(let outcome):
                return .refused(message: outcome.message ?? "That could not be saved.", existingId: outcome.existingId)
            // An edit that changed nothing (an Apple Health batch with nothing new) writes nothing.
            case .unchanged:
                return .saved()
            case .saved(let next, let shown, let counts):
                recordJSON = next
                display(shown)
                publish(choices)
                onEdit?()
                return .saved(healthRecords: counts)
            }
        } catch {
            return .refused(message: error.localizedDescription, existingId: nil)
        }
    }

    // MARK: Per-test units (US-25 AC17e)

    /// Whether an edit is a typed Lp(a) value, read in Lp(a)'s own unit. Run in a change's
    /// turn: the history is read off the main thread, from the record that edit lands on.
    private func readsLpa(_ edit: RecordEdit) async -> Bool {
        switch edit {
        case .add(let metric, _, _): return metric == "lpa"
        case .correct(let id, _):
            let lpa = try? await engine.history(recordJSON: recordJSON, metric: "lpa", now: .now, deviceId: deviceId, units: unitChoices.json)
            return lpa?.rows.contains { $0.id == id } ?? false
        default: return false
        }
    }

    /// The master switch clears every per-test choice, as the web's does, on the phone's
    /// file and in the cloud alike.
    static func clearsChoices(_ edit: RecordEdit) -> Bool {
        if case .units = edit { true } else { false }
    }

    /// An edit whose number is read in the record's units, as cloud.ts `dependsOnUnits`.
    /// Not feet and inches: they mean the same height in either units.
    nonisolated static func dependsOnUnits(_ edit: RecordEdit) -> Bool {
        switch edit {
        case .add, .correct: true
        case .profile(_, _, _, let height): height != nil
        default: false
        }
    }

    /// The choices now in force, kept on the phone. An erase and the master switch publish
    /// none: a fresh start whose onboarding asks in the record's units (adversary R1).
    func publish(_ choices: UnitChoices) {
        guard choices != unitChoices else { return }
        unitChoices = choices
        unitChoices.save()
    }
}
