import SwiftUI

/// The new-user flow's steps: start, Apple Health, saving each answer, and moving on (US-54).
extension OnboardingView {
    func begin() async {
        guard mode == .starting else { return }
        // An unreadable record: My data says why, so never strand the person here (review R13).
        guard let data = store.myData else { return send(.began(nil)) }
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
            guard !Task.isCancelled, mode == .starting else { return }
        }
        // Each typed screen starts in the record's units: the region default for a new record.
        answers.height.us = recordUnits(.height) == "conventional"
        answers.weight.us = recordUnits(.weight) == "conventional"
        await prefill(from: HealthCharacteristics.none)
        // Gone while the engine filled the boxes: nothing to pin.
        guard !Task.isCancelled, mode == .starting else { return }
        // Pinned as it shows: each answer is checked against the record its screen showed (US-25 AC11g).
        send(.began(firstPage()))
    }

    /// The first page for the record now shown (nil when it cannot be read): begin's, and a restart's.
    private func firstPage() -> OnboardingFlow.Page? {
        noteSupplied()
        guard let profile else { return nil }
        return .init(step: OnboardingSteps.first(profile, onlyMissing: onlyMissing, healthAsked: healthAsked, skip: supplied,
                                                 weightDay: weightRow?.latest?.day, hasWeight: recordWeight != nil))
    }

    /// The record moved under the page (US-54 AC5d): take the record now shown, fill the boxes
    /// left alone from it, and plan the flow again, as begin does.
    private func restart() async {
        store.repinScreen()
        answers.forget(whatIsNotIn: profile)
        // "From Apple Health" only on an answer the record still holds.
        fromHealth = fromHealth.filter { step in
            switch step {
            case .sex: profile?.sex != nil
            case .birth: profile?.birthYear != nil
            case .height: profile?.height != nil
            case .weight: recordWeight != nil
            case .health, .review: false
            }
        }
        await prefill(from: HealthCharacteristics.none)
        send(.replanned(firstPage()))
    }

    /// Moves the flow by `event` and runs the effects it names. A page change slides; the
    /// first page and the end do not.
    func send(_ event: OnboardingFlow.Event) {
        let (next, effects) = OnboardingFlow.transition(mode, event)
        if let from = mode.step, let to = next.step, from != to {
            withAnimation(.snappy) { mode = next }
        } else {
            mode = next
        }
        effects.forEach(run)
    }

    private func run(_ effect: OnboardingFlow.Effect) {
        switch effect {
        case .pin: store.pinScreen()
        case .repin: store.repinScreen()
        case .unpin: store.unpinScreen()
        case .finish: finish()
        case .connect: Task { await connect() }
        case .restart: Task { await restart() }
        case .save(let step): Task { land(await save(step), step) }
        // "Replace it": a FHIR correction of today's weight with the weight its question held, never a removal.
        case .replace(let replace): Task { land(.replaced(await store.apply(.correct(id: replace.id, value: replace.value))), .weight) }
        }
    }

    /// Allow's connect, started once by the flow (S6 bug D).
    private func connect() async {
        let heightBefore = profile?.height
        let weightBefore = recordWeight
        await health.connect()
        // Only once Apple Health has answered: a quit inside its sheet asks again.
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
        send(.connected(next: next(after: .health)))
    }

    /// Fills the answers from the record first, then from Apple Health, else wheels'
    /// sensible starts and empty boxes.
    private func prefill(from health: HealthCharacteristics) async {
        answers.sex = profile?.sex ?? health.sex ?? answers.sex
        if let year = profile?.birthYear ?? health.birthYear {
            answers.birthYear = year
            answers.birthMonth = profile?.birthMonth ?? health.birthMonth ?? answers.birthMonth
            answers.birthAnswered = true
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

    /// Saves an answer: its value read, converted by the engine off the main thread, and
    /// written. The page waits, its save claimed by the tap.
    private func save(_ step: OnboardingStep) async -> OnboardingFlow.SaveOutcome {
        switch await change(for: step) {
        case .stay: return .stay
        case .unchanged: return .unchanged
        case .edit(let edit, let typed): return .applied(await store.apply(edit), typed: typed)
        }
    }

    /// What a save came to, with the step after this one worked out from the record now.
    private func land(_ outcome: OnboardingFlow.SaveOutcome, _ step: OnboardingStep) {
        send(.landed(OnboardingFlow.landing(outcome, step: step, moved: !store.pinStillShown), next: next(after: step)))
    }

    /// The step after `step`, from the record as it is now; nil when there is none.
    private func next(after step: OnboardingStep) -> OnboardingStep? {
        noteSupplied()
        guard let profile else { return nil }
        return OnboardingSteps.next(after: step, profile: profile, hasWeight: recordWeight != nil, onlyMissing: onlyMissing, skip: supplied)
    }

    /// `typed`: a typed weight, in the record's units, which "Replace it" would write.
    private enum Change { case stay, unchanged, edit(RecordEdit, typed: Double? = nil) }

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
            return await answers.height.edit(recordUnits: recordUnits(.height), convert: store.convert).map { Change.edit($0) } ?? .stay
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
            // Converted once, here: "Replace it" writes this same number (AC5).
            let typed = await answers.weight.saved(recordUnits: recordUnits(.weight), convert: store.convert)
            return typed.map { Change.edit(.add(metric: "weight", value: $0, day: DayText.iso(.now)), typed: $0) } ?? .stay
        }
    }

    /// A typed screen's unit switch, for entry only (AC6): the record's units stay as they
    /// are. A box left alone shows the record's value again in the new units; a typed one
    /// is converted. Both through the engine.
    func chooseUnits(us: Bool, on step: OnboardingStep) {
        send(.wordsStale)
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

    /// Back: the summary for an answer opened from it, else the step before.
    func previous(_ page: OnboardingFlow.Page) -> OnboardingFlow.Page? {
        page.fromSummary ? .init(step: .review) : OnboardingSteps.previous(before: page.step, onlyMissing: onlyMissing, skip: supplied).map { .init(step: $0) }
    }
}
