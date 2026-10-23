import SwiftUI

/// The new-user flow (US-54, design ios/onboarding.md): Apple Health, then one
/// question per screen (sex, birth month and year, height, weight), then My plan.
/// Every answer is written through the engine's own edits as the person goes,
/// so quitting keeps it and the next launch resumes (AC7).
struct OnboardingView: View {
    let store: RecordStore
    let health: AppleHealthSync
    /// After "I already use Health Roadmap": only the questions the record lacks (AC2).
    let onlyMissing: Bool
    /// Never write the phone's region's units: the record's own were kept (after an erase).
    let keepUnits: Bool
    let finish: () -> Void

    /// A setting, not health data: the Apple Health screen was answered once.
    @AppStorage("onboardingHealthAsked") private var healthAsked = false
    @State private var step: OnboardingStep?
    @State private var answers = Answers()
    @State private var fromHealth: Set<OnboardingStep> = []
    @State private var message: String?
    @State private var connecting = false
    /// Birth has an answer: from the record, from Apple Health, or a wheel the person
    /// moved. A wheel's starting value is never taken as an answer (AC4). Height and
    /// weight are typed: their answer is a number in the box.
    @State private var birthAnswered = false
    @FocusState private var focus: Field?
    @Environment(\.dynamicTypeSize) private var typeSize
    /// Today's weight row a changed weight would replace, while the person decides (AC5).
    @State private var replacing: String?
    /// An answer is being saved: the page waits for it before moving on.
    @State private var saving = false

    private var profile: MyData.Profile? { store.myData?.profile }
    /// The units the engine's edits read: the record's for height, weight's own for weight,
    /// which may differ from the record's (US-25 AC17e, adversary R1).
    private func recordUnits(_ step: OnboardingStep) -> String {
        step == .weight ? store.units(for: "weight") : store.myData?.unitSystem ?? "si"
    }
    private var weightRow: MyData.Row? { store.myData?.vitals.first { $0.metric == "weight" } }

    var body: some View {
        NavigationStack {
            Group {
                if let step {
                    page(step)
                        .disabled(saving)
                        .id(step)
                        .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)).combined(with: .opacity))
                } else {
                    ProgressView()
                }
            }
            .toolbar {
                if let step, let back = previous(step) {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Back", systemImage: "chevron.left") { go(back) }
                            .disabled(saving)
                            .accessibilityIdentifier("onboarding.back")
                    }
                }
            }
        }
        .interactiveDismissDisabled()
        .task { await begin() }
        // Pinned in begin(); a run that never began never pinned.
        .onDisappear { if step != nil { store.unpinScreen() } }
        .confirmationDialog("Today already has a weight", isPresented: Binding(get: { replacing != nil }, set: { if !$0 { replacing = nil } }), titleVisibility: .visible) {
            Button("Replace it") { replaceWeight() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Replace today's weight with this one? The old value stays in your history, marked as replaced.")
        }
        .sensoryFeedback(.selection, trigger: step)
    }

    // MARK: Pages

    @ViewBuilder private func page(_ step: OnboardingStep) -> some View {
        switch step {
        case .health:
            Page(symbol: "heart.fill", tint: .pink, title: "Use your Apple Health data",
                 detail: "So you type less. What it reads goes only into your record, on this iPhone or in your own cloud. Values you add here are saved back to Apple Health.",
                 progress: nil, spread: true) {
                HealthFillScene()
            } actions: {
                appleAsksNext
                primary(connecting ? "Connecting…" : "Connect Apple Health", id: "onboarding.allow") { Task { await allowHealth() } }
                    .disabled(connecting)
                secondary("Not now", id: "onboarding.notNow") { healthAsked = true; advance(from: .health) }
            }
        case .sex:
            // A tap is the answer: it saves and moves on, so the step has no Continue (Brad 2026-10-23).
            Page(symbol: "person.fill", tint: .accentColor, title: "What is your sex?",
                 detail: "Your plan's targets and screenings depend on it.", progress: step, fromHealth: fromHealth.contains(.sex), message: message) {
                HStack(spacing: 12) {
                    choice("Female", value: "female")
                    choice("Male", value: "male")
                }
            }
        case .birth:
            Page(symbol: "calendar", tint: .orange, title: "When were you born?",
                 detail: "Your age decides which checks you're due for, like bowel and breast cancer screening and bone density (DEXA) scans. We never ask for the day.",
                 progress: step, fromHealth: fromHealth.contains(.birth), message: message) {
                HStack(spacing: 0) {
                    Picker("Month", selection: $answers.birthMonth) {
                        ForEach(Self.months, id: \.self) { Text(DayText.monthName($0)).tag($0) }
                    }
                    Picker("Year", selection: $answers.birthYear) {
                        ForEach(Self.birthYears, id: \.self) { Text(String($0)).tag($0) }
                    }
                }
                .pickerStyle(.wheel)
                .onChange(of: [answers.birthMonth, answers.birthYear]) { birthAnswered = true }
            } actions: {
                primary("Continue", id: "onboarding.continue") { save(.birth) }.disabled(!birthAnswered)
            }
        case .height:
            Page(symbol: "ruler", tint: .teal, title: "How tall are you?",
                 detail: "Height sets your healthy weight range.", progress: step, fromHealth: fromHealth.contains(.height), message: message) {
                withUnits(.height) {
                    if answers.height.us {
                        numberField(.feet)
                        numberField(.inches)
                    } else {
                        numberField(.height)
                    }
                }
            } actions: {
                primary("Continue", id: "onboarding.continue") { save(.height) }
                    .disabled(answers.height.value == nil)
            }
        case .weight:
            // Required (Brad 2026-10-23): weight shapes much of the plan, so there is no Skip.
            Page(symbol: "scalemass.fill", tint: .indigo, title: "What do you weigh?",
                 detail: "Weight shapes much of your plan.", progress: step, fromHealth: fromHealth.contains(.weight), message: message) {
                withUnits(.weight) {
                    numberField(.weight)
                }
            } actions: {
                primary("Continue", id: "onboarding.continue") { save(.weight) }
                    .disabled(answers.weight.value == nil)
            }
        }
    }

    /// The last thing read before the tap: the two taps Apple's sheet asks for (AC3).
    /// A hint, never a switch: no app can turn that sheet's switches on.
    private var appleAsksNext: some View {
        Label {
            Text("Apple asks next: tap **Turn On All**, then **Allow**.")
        } icon: {
            Image(systemName: "hand.tap.fill").foregroundStyle(.pink)
        }
        .font(.subheadline)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.pink.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .padding(.bottom, 6)
        .accessibilityElement(children: .combine)
    }

    /// The number boxes with their unit switch beside them, or under them at accessibility
    /// sizes. The switch is for entry only (AC6): it never writes the record's units.
    private func withUnits<Fields: View>(_ step: OnboardingStep, @ViewBuilder fields: () -> Fields) -> some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 16)) : AnyLayout(HStackLayout(spacing: 12))
        let names = Self.unitNames[step]!
        return layout {
            HStack(spacing: 8) { fields() }
            Picker("Units", selection: Binding(get: { answer(step).us }, set: { chooseUnits(us: $0, on: step) })) {
                Text(names.metric).tag(false)
                Text(names.us).tag(true)
            }
            .pickerStyle(.segmented)
            .fixedSize()
            .accessibilityIdentifier("onboarding.\(step)Units")
        }
        .onAppear { focus = firstField(step) }
    }

    /// One large number box, focused by its screen, with the web's typing rule (`TypedNumber`).
    private func numberField(_ field: Field) -> some View {
        let (label, unit, kind): (String, String?, TypedNumber) = switch field {
        case .height: ("Height in centimetres", nil, .value)
        case .feet: ("Feet", "ft", Self.wholeFeet)
        case .inches: ("Inches", "in", Self.wholeInches)
        case .weight: (answers.weight.us ? "Weight in pounds" : "Weight in kilograms", nil, .value)
        }
        return BigNumberField(placeholder: "0", text: typed(field), unit: unit, kind: kind, focus: $focus, field: field,
                              label: label, id: "onboarding.\(field.rawValue)")
            .multilineTextAlignment(.center)
            .padding(.vertical, 8)
            .padding(.horizontal, 12)
            .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    /// A box's text. Only the person's typing reaches the setter: it marks the answer edited.
    private func typed(_ field: Field) -> Binding<String> {
        let path: WritableKeyPath<TypedAnswer, String> = switch field {
        case .height, .weight: \.text
        case .feet: \.feet
        case .inches: \.inches
        }
        let answer: WritableKeyPath<Answers, TypedAnswer> = field == .weight ? \.weight : \.height
        return Binding(get: { answers[keyPath: answer][keyPath: path] }, set: { text in
            guard text != answers[keyPath: answer][keyPath: path] else { return }
            answers[keyPath: answer][keyPath: path] = text
            answers[keyPath: answer].edited = true
            message = nil
        })
    }

    private func answer(_ step: OnboardingStep) -> TypedAnswer { step == .weight ? answers.weight : answers.height }

    /// The box a typed screen focuses, on arrival and after its unit switch.
    private func firstField(_ step: OnboardingStep) -> Field {
        step == .weight ? .weight : answers.height.us ? .feet : .height
    }

    private func choice(_ label: String, value: String) -> some View {
        let selected = answers.sex == value
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
        return Button { answers.sex = value; save(.sex) } label: {
            Text(label)
                .font(.title3.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 64)
                .foregroundStyle(selected ? Color.onAccent : Color.primary)
                .background(selected ? Color.accentColor : Color(.secondarySystemFill), in: shape)
                .contentShape(shape)
        }
        .buttonStyle(.plain)
        .animation(.snappy, value: selected)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("onboarding.\(value)")
    }

    private func primary(_ title: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6).onAccentLabel()
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .accessibilityIdentifier(id)
    }

    private func secondary(_ title: String, id: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .padding(.top, 4)
            .accessibilityIdentifier(id)
    }

    // MARK: Flow

    private func begin() async {
        guard step == nil else { return }
        // An unreadable record: My data says why, so never strand the person here (review R13).
        guard let data = store.myData else { finish(); return }
        if onlyMissing { healthAsked = true }
        // A record from the cloud keeps its own units, also on a resumed run (Codex re-check R1),
        // as does one just erased, whose units the erase kept (US-25 AC16).
        let ownUnits = onlyMissing || keepUnits || store.cloudErase != nil
        // A new record takes the phone's region's units (AC6); a record with values keeps its own.
        let hasValues = data.profile.sex != nil || data.profile.birthYear != nil || data.profile.height != nil
            || (data.vitals + data.bloodTests + [data.psa]).contains { $0.latest != nil }
        if let units = OnboardingSteps.regionUnits(hasValues: hasValues, onlyMissing: ownUnits, current: data.unitSystem, system: Locale.current.measurementSystem) {
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
        step = onlyMissing
            ? OnboardingSteps.next(after: .health, profile: data.profile, hasWeight: recordWeight != nil, onlyMissing: true) ?? .weight
            : OnboardingSteps.start(data.profile, healthAsked: healthAsked)
        // Each answer is checked against the record its screen showed (US-25 AC11g).
        store.pinScreen()
    }

    private func allowHealth() async {
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

    /// The record's height or weight, in `recordUnits(step)`.
    private func recorded(_ step: OnboardingStep) -> Double? {
        step == .weight ? recordWeight : profile?.height.flatMap(Double.init)
    }

    private var recordWeight: Double? { weightRow?.latest.flatMap { Double($0.value) } }

    /// Saves an answer. The page waits (`saving`) while its value is read, converted by
    /// the engine off the main thread, and written.
    private func save(_ step: OnboardingStep) {
        message = nil
        saving = true
        Task {
            defer { saving = false }
            let edit: RecordEdit
            switch await change(for: step) {
            case .stay:
                return
            case .unchanged:
                return settle(.saved, step)
            case .edit(let made):
                edit = made
            }
            let result = await store.apply(edit)
            // Today already holds a weight: ask before replacing it (AC5, US-25 AC5).
            if step == .weight, case .refused(_, let existingId?) = result {
                replacing = existingId
                return
            }
            settle(result, step)
        }
    }

    private enum Change { case stay, unchanged, edit(RecordEdit) }

    /// What an answer writes: nothing new (`unchanged`, the page moves on), an edit, or
    /// nothing it can write yet (`stay`).
    private func change(for step: OnboardingStep) async -> Change {
        switch step {
        case .health:
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
            let height = answers.height
            guard height.edited else { return .unchanged }
            let edit: RecordEdit? = if height.us {
                height.feetInches.map { .feetInches(feet: $0.feet, inches: $0.inches) }
            } else {
                await savedValue(.height).map { .profile(height: $0) }
            }
            return edit.map(Change.edit) ?? .stay
        case .weight:
            // A weight equal to the record's latest, typed or not, writes nothing (AC5).
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
    private func chooseUnits(us: Bool, on step: OnboardingStep) {
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
    private func replaceWeight() {
        guard let id = replacing else { return }
        replacing = nil
        saving = true
        Task {
            defer { saving = false }
            guard let weight = await savedValue(.weight) else { return }
            let result = await store.apply(.correct(id: id, value: weight))
            settle(result, .weight)
        }
    }

    private func settle(_ result: RecordStore.ApplyResult, _ step: OnboardingStep) {
        switch result {
        case .saved:
            advance(from: step)
        case .refused(let words, _):
            // The engine's words. The record may have moved on (an erase or a unit
            // change elsewhere): pin the record now shown, so the next try is checked against it.
            message = words
            store.repinScreen()
        }
    }

    private func advance(from step: OnboardingStep) {
        guard let profile, let next = OnboardingSteps.next(after: step, profile: profile, hasWeight: recordWeight != nil, onlyMissing: onlyMissing) else {
            finish()
            return
        }
        go(next)
    }

    private func go(_ next: OnboardingStep) {
        message = nil
        store.repinScreen()
        withAnimation(.snappy) { step = next }
    }

    private func previous(_ step: OnboardingStep) -> OnboardingStep? {
        let earlier = OnboardingStep.allCases.filter { $0 < step && !(onlyMissing && $0 == .health) }
        return earlier.last
    }

    /// Built once: the wheels redraw on every tick.
    private static let months = Array(1...12)
    private static let birthYears = DayText.birthYears(now: .now)

    /// What each box takes as typed: whole feet, whole inches (centimetres and weight take `.value`).
    private static let wholeFeet = TypedNumber(whole: 1, decimals: 0)
    private static let wholeInches = TypedNumber(whole: 2, decimals: 0)

    /// Each typed screen's unit switch: its metric and US names.
    private static let unitNames: [OnboardingStep: (metric: String, us: String)] = [.height: ("cm", "ft in"), .weight: ("kg", "lb")]

    /// The answers. The wheels' defaults are a starting point the person moves from;
    /// height and weight are text as typed, in each box's own units.
    struct Answers: Equatable {
        var sex: String?
        var birthYear = DayText.gregorian.component(.year, from: .now) - 40
        var birthMonth = 1
        var height = TypedAnswer(metric: "height")
        var weight = TypedAnswer(metric: "weight")
    }

    private enum Field: String { case height, feet, inches, weight }

    // MARK: Layout

    /// One onboarding screen: symbol, title, one line on why, the control, then the buttons.
    fileprivate struct Page<Content: View, Actions: View>: View {
        let symbol: String
        let tint: Color
        let title: String
        let detail: String
        let progress: OnboardingStep?
        var fromHealth = false
        var message: String?
        /// Shares the screen's height between the heading and the content, so a short page
        /// leaves no gap above its buttons (Brad 2026-10-23).
        var spread = false
        @ViewBuilder let content: () -> Content
        @ViewBuilder let actions: () -> Actions

        var body: some View {
            VStack(spacing: 0) {
                if let progress, let index = OnboardingStep.questions.firstIndex(of: progress) {
                    ProgressView(value: Double(index + 1), total: Double(OnboardingStep.questions.count))
                        .accessibilityLabel("Question \(index + 1) of \(OnboardingStep.questions.count)")
                        .padding(.bottom, 12)
                }
                GeometryReader { screen in
                ScrollView {
                    VStack(spacing: 14) {
                        if spread { Spacer(minLength: 0) }
                        Image(systemName: symbol)
                            .font(.system(size: 44))
                            .foregroundStyle(tint)
                            .padding(.top, 24)
                            .accessibilityHidden(true)
                        Text(title)
                            .font(.title.bold())
                            .multilineTextAlignment(.center)
                            .accessibilityAddTraits(.isHeader)
                        Text(detail)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        if fromHealth {
                            Label("From Apple Health", systemImage: "heart.fill")
                                .font(.footnote)
                                .foregroundStyle(.pink)
                        }
                        if spread { Spacer(minLength: 12).frame(maxHeight: 48) }
                        content().padding(.top, spread ? 0 : 12)
                        if spread { Spacer(minLength: 0) }
                    }
                    .frame(maxWidth: .infinity, minHeight: spread ? screen.size.height : nil)
                }
                .scrollBounceBehavior(.basedOnSize)
                }
                VStack(spacing: 6) {
                    // The engine's own words for a refused answer (AC5).
                    if let message {
                        Text(message).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
                    }
                    actions()
                }
                .padding(.top, 12)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 12)
        }
    }
}

extension OnboardingView.Page where Actions == EmptyView {
    /// A page whose control is its answer (sex): no buttons.
    init(symbol: String, tint: Color, title: String, detail: String, progress: OnboardingStep?, fromHealth: Bool, message: String?,
         @ViewBuilder content: @escaping () -> Content) {
        self.init(symbol: symbol, tint: tint, title: title, detail: detail, progress: progress, fromHealth: fromHealth, message: message,
                  content: content, actions: { EmptyView() })
    }
}
