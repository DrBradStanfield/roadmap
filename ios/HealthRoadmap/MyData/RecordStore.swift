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
        case saved
        /// Nothing changed. `existingId` names the row that already holds that day.
        case refused(message: String, existingId: String?)
    }

    /// The record as stored, JSON text.
    private(set) var recordJSON: String { didSet { if recordJSON != oldValue { revision += 1 } } }
    /// My data and the plan, from one engine call, so the two always show the same record
    /// (US-25 AC2); nil while the record cannot be read.
    private(set) var drawn: HealthEngine.Drawn?
    /// What My data shows; nil while the record cannot be read.
    var myData: MyData? { drawn?.myData }
    /// What the Plan tab shows; nil while the record cannot be read.
    var plan: PlanState? { drawn?.plan }
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
    /// While a cloud is connected but its record is not open: the marker a phone edit
    /// sets, in the same engine step that writes it, so the next open merges it up
    /// (US-09 AC4). Read when the edit's turn comes: an edit asked for before a first
    /// connect, landing after it, is marked too. Set by CloudSync; nil with no cloud.
    @ObservationIgnored var marksPending: PhoneFiles?
    /// Moves each time "Delete all my data" erases the record here (US-25 AC16),
    /// so a view holding health data outside the record, the open chat, drops it.
    private(set) var erasures = 0
    /// Per-test units (US-25 AC17e): this phone's preference, as the web's are its browser's.
    private(set) var unitChoices = UnitChoices.saved() { didSet { if unitChoices != oldValue { revision += 1 } } }
    /// The person's own saves (US-57 AC9): a sheet's edit or a lab report's values that
    /// changed the record, never an Apple Health import (`applyNow`) or a units choice.
    /// The cloud prompt counts them.
    private(set) var ownSaves = 0
    /// Moves whenever the record or the per-test units change: a page keyed on it asks again.
    private(set) var revision = 0
    /// Where the record is kept.
    let file: URL
    let deviceId: String
    private let engine: HealthEngine

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
    private var pinned: Screen?
    private var pins = 0
    /// The last change asked for: each waits for the one before (`chain`). Released when
    /// it finishes, so its result is not kept; nothing is left to wait for then.
    @ObservationIgnored private var tail: (@MainActor () async -> Void)?
    @ObservationIgnored private var chained = 0
    /// The engine's stamp on the cloud record shown: one handed over earlier is stale.
    @ObservationIgnored private var shownOrder = 0

    var screen: Screen {
        Screen(erase: cloudErase, units: myData?.unitSystem ?? "si", choices: unitChoices.json, lpaUnit: myData?.lpaUnit ?? "")
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
    private func display(_ drawn: HealthEngine.Drawn?) {
        self.drawn = drawn
        if drawn?.plan.planned == true { engine.trial?.confirm() }
    }

    /// Shows what the phone's file holds.
    private func show(_ loaded: PhoneLoad) {
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

    // MARK: Cloud (US-25 AC11)

    /// Show the cloud record the engine opened or took in, and send edits to it.
    /// A record the screen cannot draw is not shown; the last good one stays.
    @discardableResult
    func showCloud(_ view: HealthEngine.CloudView) -> Task<Void, Never> {
        chain { await self.draw(view) }
    }

    /// The cloud handover (CloudSync's open), as one step in line: every edit asked for
    /// before it has landed on the phone's file and been counted when `decide` runs.
    /// `decide` answers whether to show `view` (no edit came in while the open ran);
    /// when it does, the view is drawn in the same step. False: open again.
    func handOver(to view: HealthEngine.CloudView, if decide: @escaping @MainActor () -> Bool) async -> Bool {
        await chain {
            guard decide() else { return false }
            await self.draw(view)
            return true
        }.value
    }

    /// `choices`: the per-test units to draw it in, published with it (nil: those in force).
    /// False when it was not drawn: nothing on screen moved, the units included.
    @discardableResult
    private func draw(_ view: HealthEngine.CloudView, in choices: UnitChoices? = nil) async -> Bool {
        // One the engine handed over before the record now shown is stale: the screen
        // keeps the newer one (a re-read that crossed an edit).
        if let order = view.order {
            guard order > shownOrder else { return false }
            shownOrder = order
        }
        let choices = choices ?? unitChoices
        guard let shown = try? await engine.screen(recordJSON: view.record, now: .now, deviceId: deviceId, units: choices.json) else { return false }
        recordJSON = view.record
        display(shown)
        publish(choices)
        problem = nil
        cloudErase = view.erase
        cloudSession = view.session
        return true
    }

    /// Back to the phone's own file (Disconnect, or a cloud that could not open).
    @discardableResult
    func showPhone() -> Task<Void, Never> {
        chain {
            self.cloudErase = nil
            let (file, deviceId, units) = (self.file, self.deviceId, self.unitChoices.json)
            do {
                self.show(try await self.engine.loadPhone(file, deviceId: deviceId, units: units))
            } catch {
                self.display(nil)
                self.problem = "Your record on this iPhone could not be opened. \(error.localizedDescription)"
            }
        }
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

    /// Every value recorded for one metric (US-25 AC9), for the record and units shown now;
    /// nil while the record cannot be read.
    func history(for metric: String) async -> MetricHistory? {
        await chart(for: metric)?.history
    }

    /// The history and its chart's inputs, read by the engine once per `revision` and metric,
    /// off the main thread: a second ask while that read runs (a page and the page above it)
    /// joins it. Kept in `histories`, which a page draws; older revisions' are dropped.
    func chart(for metric: String) async -> ChartData? {
        guard problem == nil else { return nil }
        let revision = revision
        if let kept = histories[metric], kept.revision == revision { return kept.chart }
        if let read = reading[metric], read.revision == revision { return await read.task.value }
        let (units, record, deviceId, engine) = (unitChoices.json, recordJSON, deviceId, engine)
        let task = Task {
            (try? await engine.history(recordJSON: record, metric: metric, now: .now, deviceId: deviceId, units: units)).map(ChartData.init)
        }
        reading[metric] = (revision, task)
        let chart = await task.value
        if reading[metric]?.revision == revision { reading[metric] = nil }
        // The record moved on while the engine ran: a page asks again for the new one.
        if revision == self.revision {
            histories = histories.filter { $0.value.revision == revision }
            histories[metric] = KeptHistory(revision: revision, chart: chart)
        }
        return chart
    }

    /// The chart last read for `metric`, for a page to draw: it may trail the record by one
    /// engine call, and the page's `.task(id: revision)` brings it up to date.
    func shownChart(for metric: String) -> ChartData? {
        problem == nil ? histories[metric]?.chart : nil
    }

    /// The history read for the record and units as they are now; nil while it trails them
    /// (adversary R2). Only this one may open a correction: a page keeps drawing the older
    /// one, its taps held, until the fresh one lands.
    func shownHistory(for metric: String) -> MetricHistory? {
        guard problem == nil, let kept = histories[metric], kept.revision == revision else { return nil }
        return kept.chart?.history
    }

    /// A correction sheet's "Now" hint: the value as a current history shows it, only from a
    /// history in `unit`, the one the sheet shows (and for Lp(a), its screen's). Nil until one
    /// is read, never a number in another unit ("100 mg/dL" from 100 nmol/L, Codex R2;
    /// "176.4 kg" once the record flips to lb, re-check N1).
    func correctionHint(for id: String, metric: String, unit: String, on screen: Screen) -> String? {
        guard let history = shownHistory(for: metric), history.unit == unit,
              metric != "lpa" || history.unit == screen.lpaUnit else { return nil }
        return history.rows.first { $0.id == id }?.value
    }

    /// A row tap (AC9): only the latest one, with no erase since, may open a page or a sheet
    /// once its history is read (re-check N4). Taken in the tap.
    struct Tap: Equatable {
        fileprivate let tap: Int
        fileprivate let erasures: Int
    }
    func tap() -> Tap {
        taps += 1
        return Tap(tap: taps, erasures: erasures)
    }
    func isLatest(_ tap: Tap) -> Bool { tap == Tap(tap: taps, erasures: erasures) }
    @ObservationIgnored private var taps = 0

    private struct KeptHistory {
        let revision: Int
        let chart: ChartData?
    }
    private var histories: [String: KeptHistory] = [:]
    /// A history the engine is reading, for the revision it was asked at.
    @ObservationIgnored private var reading: [String: (revision: Int, task: Task<ChartData?, Never>)] = [:]

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
        return result
    }

    /// The units the row for `metric` shows: its per-test choice, else the record's (AC17e).
    func units(for metric: String) -> String {
        unitChoices.system(for: metric, record: myData?.unitSystem ?? "si")
    }

    /// An edit no sheet opened, such as an Apple Health import (D6): checked against
    /// the record as it is now, never against a sheet's pin, so an open sheet cannot
    /// make it refuse. It still takes the same path: in the cloud, the session, the
    /// merge and the erase guard.
    /// Its turn in line decides "now": the screen is read when the edits before it have landed.
    func applyNow(_ edit: RecordEdit) async -> ApplyResult {
        await chain { await self.applyInTurn(edit, as: self.screen) }.value
    }

    private func applyInTurn(_ edit: RecordEdit, as seen: Screen) async -> ApplyResult {
        // An erase taken in, or sync turned on or off, since the sheet opened.
        // The sheet keeps refusing until it closes: it still shows the old record,
        // its unit and the typed number, so a second Save would store that number
        // in a record or units it never showed (re-check R1).
        guard seen.erase == cloudErase else {
            return .refused(message: "Your record changed while this was open, so this was not saved. Close this and enter the value again.", existingId: nil)
        }
        if let erase = seen.erase { return await applyInCloud(edit, erase: erase, seen: seen) }
        if let problem { return .refused(message: problem, existingId: nil) }
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
                return .saved
            case .saved(let next, let shown):
                recordJSON = next
                display(shown)
                publish(choices)
                onEdit?()
                return .saved
            }
        } catch {
            return .refused(message: error.localizedDescription, existingId: nil)
        }
    }

    /// Through the engine's open session: the save loop sends it to the cloud.
    private func applyInCloud(_ edit: RecordEdit, erase: String, seen: Screen) async -> ApplyResult {
        do {
            return await shown(try await engine.cloudEdit(edit, erase: erase, units: seen.units, now: .now, choices: seen.choices, lpaUnit: seen.lpaUnit), of: edit)
        } catch {
            return .refused(message: error.localizedDescription, existingId: nil)
        }
    }

    /// What the session made of a cloud edit, onto the screen.
    private func shown(_ outcome: EditOutcome, of edit: RecordEdit) async -> ApplyResult {
        guard outcome.ok, let next = outcome.record, let nextErase = outcome.erase else {
            return .refused(message: outcome.message ?? "That could not be saved.", existingId: outcome.existingId)
        }
        if next == recordJSON { return .saved }
        // The session has taken the edit: the choices follow it, once it is drawn (adversary R4).
        await draw(HealthEngine.CloudView(record: next, erase: nextErase, session: cloudSession ?? 0, order: outcome.order),
                   in: Self.clearsChoices(edit) ? UnitChoices() : nil)
        onEdit?()
        return .saved
    }

    // MARK: Lab reports (US-52 AC8)

    /// The ticked values of a lab report, and what saving them did. The summary is taken
    /// in the same turn as the import, against the record it lands on (in the cloud, the
    /// session's working copy, in one engine step), so it never counts a value another
    /// device brought in meanwhile as saved (Codex re-check R3).
    func importLabs(extractionJSON: String, refs: [String], reportDay: String) async -> Result<LabSaveSummary, LabRefusal> {
        let seen = pinned ?? screen
        let (result, changed) = await chain {
            let before = self.recordJSON
            return (await self.importLabsInTurn(extractionJSON: extractionJSON, refs: refs, reportDay: reportDay, as: seen), self.recordJSON != before)
        }.value
        if changed, case .success = result { ownSaves += 1 }
        return result
    }

    private func importLabsInTurn(extractionJSON: String, refs: [String], reportDay: String, as seen: Screen) async -> Result<LabSaveSummary, LabRefusal> {
        let edit = RecordEdit.labImport(extractionJSON: extractionJSON, refs: refs, reportDay: reportDay)
        do {
            let summary: Result<LabSaveSummary, LabRefusal>
            let result: ApplyResult
            if let erase = seen.erase, erase == cloudErase {
                let answer = try await engine.cloudLabImport(extractionJSON: extractionJSON, refs: refs, reportDay: reportDay, erase: erase,
                                                             units: seen.units, now: .now, choices: seen.choices)
                result = await shown(answer.outcome, of: edit)
                summary = answer.summary.map { .success($0) } ?? .failure(LabRefusal(message: answer.outcome.message ?? "These values could not be saved."))
            } else {
                // The phone's file (or a screen that moved on, which `apply` refuses): nothing
                // else changes the record before this turn ends.
                summary = try await engine.labSaveSummary(recordJSON: recordJSON, extractionJSON: extractionJSON, refs: refs, reportDay: reportDay, now: .now, deviceId: deviceId)
                guard case .success = summary else { return summary }
                result = await applyInTurn(edit, as: seen)
            }
            if case .refused(let message, _) = result { return .failure(LabRefusal(message: message)) }
            return summary
        } catch {
            return .failure(LabRefusal(message: error.localizedDescription))
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
        return await chain { await self.saveDocumentInTurn(extractionJSON: extractionJSON, choice: choice, original: original, as: seen) }.value
    }

    private func saveDocumentInTurn(extractionJSON: String, choice: DocumentChoice, original: LabFileReader.Original?, as seen: Screen) async -> DocumentResult {
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
                    await draw(HealthEngine.CloudView(record: next, erase: nextErase, session: cloudSession ?? 0, order: answer.order))
                    onEdit?()
                }
                return result
            }
            guard try await commitPhoneDocument(next, over: before) else {
                return .refused("Your record changed while this was saving, so it was not saved. Save again.")
            }
            return result
        } catch {
            return .refused(error.localizedDescription)
        }
    }

    /// A document save's record, onto the phone's file: written only over the record the
    /// save began from (`before`), never over an edit made while it ran. False when refused.
    /// Runs inside a chained change (saveDocument); never chain it, or it waits on itself.
    func commitPhoneDocument(_ next: String, over before: String) async throws -> Bool {
        guard cloudErase == nil, recordJSON == before else { return false }
        if next != recordJSON {
            let shown = try await engine.drawAndWrite(next, units: unitChoices.json, to: file, marking: marksPending, deviceId: deviceId)
            recordJSON = next
            display(shown)
            onEdit?()
        }
        return true
    }

    /// A typed value in the other units ("si" or "conventional"), by the engine; nil if it
    /// cannot. Onboarding's entry-only unit switches (US-54 AC6).
    func convert(_ value: Double, metric: String, from: String, to: String) async -> HealthEngine.Conversion? {
        try? await engine.convert(value, metric: metric, from: from, to: to)
    }

    // MARK: Per-test units (US-25 AC17e)

    /// Unit switches asked for and not yet landed, per-test or the master one. While one
    /// is pending, a sheet would pin the old units and label itself from the new row:
    /// entry waits (AC17e).
    private(set) var unitSwitches = 0

    /// One test to the other units, as the web's unit chip does. Back to the record's
    /// units drops the choice; nothing is written to the record.
    @discardableResult
    func switchUnits(for row: MyData.Row, to system: String) -> Task<Void, Never> {
        unitSwitches += 1
        return chain {
            defer { self.unitSwitches -= 1 }
            guard row.switchable == true, let data = self.myData else { return }
            let choices = self.unitChoices.setting(row.metric, to: system == data.unitSystem ? nil : system)
            // Drawn first: a choice the screen cannot show is not kept, so labels and reading agree.
            guard let shown = try? await self.engine.screen(recordJSON: self.recordJSON, now: .now, deviceId: self.deviceId, units: choices.json) else { return }
            self.display(shown)
            self.publish(choices)
        }
    }

    /// Lp(a)'s units, in the web's order (health-core's LPA_UNITS).
    static let lpaUnits = ["nmol/L", "mg/dL", "mg/L"]

    /// Lp(a)'s unit, from its page's menu or a sheet's picker (US-05 AC2, US-25 AC20): a record
    /// edit, as the web's control writes it, so it syncs; the unit already stored writes nothing.
    /// Not a typed value, so it is checked against the record when its turn comes, never a
    /// sheet's screen. Entry waits while it lands, as for any unit switch. A sheet open as it
    /// is chosen there shows it from then on and moves its own screen with it
    /// (`ValueEntrySheet.lpaUnits`), so a value typed there is read in the unit shown at Save.
    /// Entry is held, and its turn taken, in the tap itself, as `switchUnits` does: a tap
    /// queued behind the menu cannot open a sheet on the old unit (merge review R1, F1).
    @discardableResult
    func setLpaUnit(_ unit: String) -> Task<ApplyResult, Never> {
        unitSwitches += 1
        return chain {
            defer { self.unitSwitches -= 1 }
            return await self.applyInTurn(.lpaUnit(unit), as: self.screen)
        }
    }

    /// The same, answering a refusal's words, nil when it was taken.
    func chooseLpaUnit(_ unit: String) -> Task<String?, Never> {
        let setting = setLpaUnit(unit)
        return Task {
            if case .refused(let message, _) = await setting.value { return message }
            return nil
        }
    }

    /// Lp(a)'s unit as the record holds it now, for an Lp(a) row; nil for any other.
    func lpaUnit(for row: MyData.Row) -> String? {
        row.metric == "lpa" ? myData?.lpaUnit : nil
    }

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
    private static func clearsChoices(_ edit: RecordEdit) -> Bool {
        if case .units = edit { true } else { false }
    }

    /// An edit whose number is read in the record's units, as cloud.ts `dependsOnUnits`.
    /// Not feet and inches: they mean the same height in either units.
    private static func dependsOnUnits(_ edit: RecordEdit) -> Bool {
        switch edit {
        case .add, .correct: true
        case .profile(_, _, _, let height): height != nil
        default: false
        }
    }

    /// The choices now in force, kept on the phone. An erase and the master switch publish
    /// none: a fresh start whose onboarding asks in the record's units (adversary R1).
    private func publish(_ choices: UnitChoices) {
        guard choices != unitChoices else { return }
        unitChoices = choices
        unitChoices.save()
    }
}
