import Foundation

/// Which record the store shows, the phone's file or a cloud record (US-25 AC11), and how the
/// screen moves between them. Split out of RecordStore.swift by what changes together: the
/// Source union (leads S10, S23, H28) replaces the cloud fields these read and write.
extension RecordStore {
    var screen: Screen {
        Screen(erase: cloudErase, units: myData?.unitSystem ?? "si", choices: unitChoices.json, lpaUnit: myData?.lpaUnit ?? "")
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
    func draw(_ view: HealthEngine.CloudView, in choices: UnitChoices? = nil) async -> Bool {
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
        (cloudErase, cloudName) = (view.erase, cloudAccount)
        cloudSession = view.session
        return true
    }

    /// Back to the phone's own file (Disconnect, or a cloud that could not open).
    @discardableResult
    func showPhone() -> Task<Void, Never> {
        chain {
            (self.cloudErase, self.cloudName) = (nil, nil)
            let (file, deviceId, units) = (self.file, self.deviceId, self.unitChoices.json)
            do {
                self.show(try await self.engine.loadPhone(file, deviceId: deviceId, units: units))
            } catch {
                self.display(nil)
                self.problem = RecordProblem(error)
            }
        }
    }

    /// Through the engine's open session: the save loop sends it to the cloud.
    func applyInCloud(_ edit: RecordEdit, erase: String, seen: Screen) async -> ApplyResult {
        do {
            return await shown(try await engine.cloudEdit(edit, erase: erase, units: seen.units, now: .now, choices: seen.choices, lpaUnit: seen.lpaUnit), of: edit)
        } catch {
            return .refused(message: error.localizedDescription, existingId: nil)
        }
    }

    /// What the session made of a cloud edit, onto the screen.
    func shown(_ outcome: EditOutcome, of edit: RecordEdit) async -> ApplyResult {
        guard outcome.ok, let next = outcome.record, let nextErase = outcome.erase else {
            return .refused(message: outcome.message ?? "That could not be saved.", existingId: outcome.existingId)
        }
        if next == recordJSON { return .saved() }
        // The session has taken the edit: the choices follow it, once it is drawn (adversary R4).
        await draw(HealthEngine.CloudView(record: next, erase: nextErase, session: cloudSession ?? 0, order: outcome.order),
                   in: Self.clearsChoices(edit) ? UnitChoices() : nil)
        onEdit?()
        return .saved(healthRecords: outcome.healthRecords)
    }
}
