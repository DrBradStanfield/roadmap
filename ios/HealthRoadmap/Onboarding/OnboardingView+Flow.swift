import SwiftUI

/// The new-user flow's steps: start, Apple Health, saving each answer, and moving on (US-54).
extension OnboardingView {
    func begin() async {
        guard step == nil else { return }
        // An unreadable record: My data says why, so never strand the person here (review R13).
        guard let data = store.myData else { finish(); return }
        fromHealth = OnboardingSteps.decode(fromHealthNames)
        if onlyMissing { healthAsked = true }
        // A record from the cloud keeps its own units, also on a resumed run (Codex re-check R1),
        // as does one just erased, whose units the erase kept (US-25 AC16).
        let ownUnits = onlyMissing || keepUnits || store.cloudErase != nil
        // A new record takes the phone's region's units (AC6); a record with values keeps its own.
        let hasValues = data.profile.sex != nil || data.profile.birthYear != nil || data.profile.height != nil
            || (data.vitals + data.bloodTests + [data.psa]).contains { $0.latest != nil }
        let engineUnits = hasValues || ownUnits ? nil : await store.regionUnits()
        if let units = OnboardingSteps.regionUnits(hasValues: hasValues, onlyMissing: ownUnits, current: data.unitSystem, locale: .current, engine: engineUnits) {
            _ = await store.apply(.units(units))
            // Gone before the units landed: nothing to pin (onDisappear unpins only a begun run).
            guard !Task.isCancelled, step == nil else { return }
        }
        // Each typed screen starts in the record's units: the region default for a new record.
        answers.height.us = recordUnits(.height) == "conventional"
        answers.weight.us = recordUnits(.weight) == "conventional"
        await prefill(from: HealthCharacteristics.none)
        // Gone while the engine filled the boxes: nothing to pin.
        guard !Task.isCancelled, step == nil else { return }
        noteSupplied()
        step = onlyMissing
            ? OnboardingSteps.next(after: .health, profile: data.profile, hasWeight: recordWeight != nil, onlyMissing: true) ?? .weight
            : OnboardingSteps.start(data.profile, healthAsked: healthAsked, skip: supplied, weightDay: weightRow?.latest?.day)
        // Each answer is checked against the record its screen showed (US-25 AC11g).
        store.pinScreen()
    }

    func allowHealth() async {
        connecting = true
        let heightBefore = profile?.height
        let weightBefore = recordWeight
        await health.connect()
        healthAsked = true
        let given = health.characteristics()
        // Label what Apple Health filled in (AC4): what the record lacked and Health gave.
        if profile?.sex == nil, given.sex != nil { fromHealth.insert(.sex) }
        if profile?.birthYear == nil, given.birthYear != nil { fromHealth.insert(.birth) }
        if heightBefore == nil, profile?.height != nil { fromHealth.insert(.height) }
        if weightBefore == nil, recordWeight != nil { fromHealth.insert(.weight) }
        await prefill(from: given)
        // Health's sex and birth are taken as given (AC3b), saved by the same edits a tap or
        // Continue makes; one the engine refuses is asked. Height and weight came in with the connect.
        // One edit for both; refused, both are asked (review E3).
        if let profile, let edit = OnboardingSteps.healthEdit(given, profile: profile), await store.apply(edit) != .saved() {
            fromHealth.subtract([.sex, .birth])
        }
        connecting = false
        advance(from: .health)
    }

    /// Fills the answers from the record first, then from Apple Health, else wheels'
    /// sensible starts and empty boxes.
    private func prefill(from health: HealthCharacteristics) async {
        answers.sex = profile?.sex ?? health.sex ?? answers.sex
        if let year = profile?.birthYear ?? health.birthYear {
            answers.birthYear = year
            answers.birthMonth = profile?.birthMonth ?? health.birthMonth ?? answers.birthMonth
            birthAnswered = true
        }
        for (step, path) in [(OnboardingStep.height, \Answers.height), (.weight, \Answers.weight)] where !answers[keyPath: path].edited {
            let (recorded, recordUnits) = (recorded(step), recordUnits(step))
            await update(path) { await $0.show(recorded, recordUnits: recordUnits, convert: store.convert) }
        }
    }

    /// Works `supplied` out again, from the record as it is now (AC3b).
    func noteSupplied() {
        supplied = profile.map { OnboardingSteps.supplied(fromHealth: fromHealth, profile: $0, weightDay: weightRow?.latest?.day, now: .now) } ?? []
    }

    /// The summary's lines (AC3b): the record's answers now, so an edit shows; worked out once per draw.
    var summaryLines: [(step: OnboardingStep, text: String, spoken: String)] {
        guard let profile else { return [] }
        let weight = weightRow.flatMap { row in row.latest.map { (value: $0.value, unit: row.unit) } }
        return OnboardingStep.questions.filter(supplied.contains).map {
            let text = OnboardingSteps.summary($0, profile: profile, weight: weight) ?? ""
            return ($0, text, OnboardingSteps.spoken($0, text: text, profile: profile))
        }
    }

    /// The record's height or weight, in `recordUnits(step)`.
    private func recorded(_ step: OnboardingStep) -> Double? {
        step == .weight ? recordWeight : profile?.height.flatMap(Double.init)
    }

    private var recordWeight: Double? { weightRow?.latest.flatMap { Double($0.value) } }

    /// Saves an answer. The page waits (`saving`) while its value is read, converted by
    /// the engine off the main thread, and written.
    func save(_ step: OnboardingStep) {
        message = nil
        saving = true
        Task {
            defer { saving = false }
            let outcome: SaveOutcome
            switch await change(for: step) {
            case .stay:
                outcome = .stay
            case .unchanged:
                outcome = .unchanged
            case .edit(let edit):
                outcome = .applied(await store.apply(edit))
            }
            land(Self.landing(outcome, step: step), step)
        }
    }

    /// What a save came to: nothing it could write (`stay`), nothing new (`unchanged`), the
    /// engine's answer to its edit, or to "Replace it" (nil: no typed weight to replace with).
    enum SaveOutcome: Equatable { case stay, unchanged, applied(RecordStore.ApplyResult), replaced(RecordStore.ApplyResult?) }

    /// What the page shows after a save: nothing new, the next step, the engine's words, or
    /// the replace prompt. Pure, so OnboardingLandingTests pins it (S6).
    enum Landing: Equatable { case stay, advance, words(String), askReplace(id: String) }

    static func landing(_ outcome: SaveOutcome, step: OnboardingStep) -> Landing {
        switch outcome {
        case .stay, .replaced(nil):
            return .stay
        case .unchanged:
            return .advance
        // Today already holds a weight: ask before replacing it (AC5, US-25 AC5).
        case .applied(.refused(_, let existingId?)) where step == .weight:
            return .askReplace(id: existingId)
        case .applied(let result), .replaced(let result?):
            switch result {
            case .saved: return .advance
            case .refused(let words, _): return .words(words)
            }
        }
    }

    private enum Change { case stay, unchanged, edit(RecordEdit) }

    /// What an answer writes: nothing new (`unchanged`, the page moves on), an edit, or
    /// nothing it can write yet (`stay`).
    private func change(for step: OnboardingStep) async -> Change {
        switch step {
        case .health, .review:
            return .stay
        case .sex:
            guard let sex = answers.sex else { return .stay }
            return profile?.sex == sex ? .unchanged : .edit(.profile(sex: sex))
        case .birth:
            return profile?.birthYear == answers.birthYear && profile?.birthMonth == answers.birthMonth
                ? .unchanged : .edit(.profile(birthYear: answers.birthYear, birthMonth: answers.birthMonth))
        // A box the person left alone saves nothing, whatever its units show (AC6). A typed
        // one that cannot be read or converted stays on its screen.
        case .height:
            guard answers.height.edited else { return .unchanged }
            return await answers.height.edit(recordUnits: recordUnits(.height), convert: store.convert).map(Change.edit) ?? .stay
        case .weight:
            // Health's year-old weight, left as it is, is confirmed as today's: an Apple Health
            // row in the row's own kilograms, never the rounded display, never written back (AC3b).
            if staleWeight, !answers.weight.edited {
                guard let id = weightRow?.latest?.id, let kg = OnboardingSteps.kilograms(rowId: id, recordJSON: store.recordJSON) else { return .stay }
                return .edit(OnboardingSteps.confirmedWeight(kilograms: kg, now: .now))
            }
            // Otherwise a weight equal to the record's latest, typed or not, writes nothing (AC5).
            guard answers.weight.edited,
                  !(await answers.weight.repeats(recordWeight, recordUnits: recordUnits(.weight), convert: store.convert))
            else { return .unchanged }
            return await savedValue(.weight).map { .edit(.add(metric: "weight", value: $0, day: DayText.iso(.now))) } ?? .stay
        }
    }

    /// A typed answer in the units the engine's edit reads now, converted once; nil when
    /// the person typed nothing there.
    private func savedValue(_ step: OnboardingStep) async -> Double? {
        await answer(step).saved(recordUnits: recordUnits(step), convert: store.convert)
    }

    /// A typed screen's unit switch, for entry only (AC6): the record's units stay as they
    /// are. A box left alone shows the record's value again in the new units; a typed one
    /// is converted. Both through the engine.
    func chooseUnits(us: Bool, on step: OnboardingStep) {
        message = nil
        let path: WritableKeyPath<Answers, TypedAnswer> = step == .weight ? \.weight : \.height
        let (recorded, recordUnits) = (recorded(step), recordUnits(step))
        // Counted in the tap: a quicker later tap wins over this one's conversion.
        let tapped = answers[keyPath: path].tapped()
        Task {
            await update(path, from: tapped) { await $0.switchUnits(toUS: us, recorded: recorded, recordUnits: recordUnits, convert: store.convert) }
            focus = firstField(step)
        }
    }

    /// Changes a typed answer through the engine, off the main thread. Kept only if the
    /// answer did not move while the engine ran (a keystroke or another switch): the box
    /// never shows text in units it no longer holds. `start`: the box as a tap left it.
    private func update(_ path: WritableKeyPath<Answers, TypedAnswer>, from start: TypedAnswer? = nil, _ change: (inout TypedAnswer) async -> Void) async {
        let before = start ?? answers[keyPath: path]
        var after = before
        await change(&after)
        answers[keyPath: path].land(after, from: before)
    }

    /// "Replace it": a FHIR correction of today's weight, never a removal.
    func replaceWeight() {
        guard let id = replacing else { return }
        replacing = nil
        saving = true
        Task {
            defer { saving = false }
            var result: RecordStore.ApplyResult?
            if let weight = await savedValue(.weight) {
                result = await store.apply(.correct(id: id, value: weight))
            }
            land(Self.landing(.replaced(result), step: .weight), .weight)
        }
    }

    private func land(_ landing: Landing, _ step: OnboardingStep) {
        switch landing {
        case .stay:
            break
        case .advance:
            advance(from: step)
        case .words(let words):
            // The engine's words. The record may have moved on (an erase or a unit
            // change elsewhere): pin the record now shown, so the next try is checked against it.
            message = words
            store.repinScreen()
        case .askReplace(let id):
            replacing = id
        }
    }

    func advance(from step: OnboardingStep) {
        // An answer opened from the summary's Edit returns to it (AC3b).
        if editing { return go(.review) }
        noteSupplied()
        guard let profile, let next = OnboardingSteps.next(after: step, profile: profile, hasWeight: recordWeight != nil, onlyMissing: onlyMissing, skip: supplied) else {
            finish()
            return
        }
        go(next)
    }

    func go(_ next: OnboardingStep) {
        message = nil
        if next == .review { editing = false }
        store.repinScreen()
        withAnimation(.snappy) { step = next }
    }

    func previous(_ step: OnboardingStep) -> OnboardingStep? {
        editing ? .review : OnboardingSteps.previous(before: step, onlyMissing: onlyMissing, skip: supplied)
    }
}
