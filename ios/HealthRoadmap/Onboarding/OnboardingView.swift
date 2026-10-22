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
    /// Questions with an answer: from the record, from Apple Health, or a wheel the
    /// person moved. A wheel's starting value is never taken as an answer (AC4).
    @State private var answered: Set<OnboardingStep> = []
    /// Today's weight row a changed weight would replace, while the person decides (AC5).
    @State private var replacing: String?

    private var profile: MyData.Profile? { store.myData?.profile }
    private var usUnits: Bool { store.myData?.unitSystem == "conventional" }
    private var weightRow: MyData.Row? { store.myData?.vitals.first { $0.metric == "weight" } }

    var body: some View {
        NavigationStack {
            Group {
                if let step {
                    page(step)
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
                            .accessibilityIdentifier("onboarding.back")
                    }
                }
            }
        }
        .interactiveDismissDisabled()
        .onAppear(perform: begin)
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
            Page(symbol: "heart.fill", tint: .pink, title: "Fill this in from Apple Health?",
                 detail: "Health Roadmap can read your sex, birth date, height, weight, waist and blood pressure from Apple Health, so you type less. They go only into your record, on this iPhone or in the cloud you connect.",
                 progress: nil) {
                EmptyView()
            } actions: {
                primary(connecting ? "Connecting…" : "Allow", id: "onboarding.allow") { Task { await allowHealth() } }
                    .disabled(connecting)
                secondary("Not now", id: "onboarding.notNow") { healthAsked = true; advance(from: .health) }
            }
        case .sex:
            Page(symbol: "person.fill", tint: .accentColor, title: "What is your sex?",
                 detail: "Your plan's targets and screenings depend on it.", progress: step, fromHealth: fromHealth.contains(.sex), message: message) {
                HStack(spacing: 12) {
                    choice("Female", value: "female")
                    choice("Male", value: "male")
                }
            } actions: {
                primary("Continue", id: "onboarding.continue") { save(.sex) }.disabled(answers.sex == nil)
            }
        case .birth:
            Page(symbol: "calendar", tint: .orange, title: "When were you born?",
                 detail: "Month and year give your age. We never ask for the day.", progress: step, fromHealth: fromHealth.contains(.birth), message: message) {
                HStack(spacing: 0) {
                    Picker("Month", selection: $answers.birthMonth) {
                        ForEach(Self.months, id: \.self) { Text(DayText.monthName($0)).tag($0) }
                    }
                    Picker("Year", selection: $answers.birthYear) {
                        ForEach(Self.birthYears, id: \.self) { Text(String($0)).tag($0) }
                    }
                }
                .pickerStyle(.wheel)
                .onChange(of: [answers.birthMonth, answers.birthYear]) { answered.insert(.birth) }
            } actions: {
                primary("Continue", id: "onboarding.continue") { save(.birth) }.disabled(!answered.contains(.birth))
            }
        case .height:
            Page(symbol: "ruler", tint: .teal, title: "How tall are you?",
                 detail: "Height sets your healthy weight range.", progress: step, fromHealth: fromHealth.contains(.height), message: message) {
                HStack(spacing: 0) {
                    if usUnits {
                        Picker("Feet", selection: $answers.feet) { ForEach(3...7, id: \.self) { Text("\($0) ft").tag($0) } }
                        Picker("Inches", selection: $answers.inches) { ForEach(0...11, id: \.self) { Text("\($0) in").tag($0) } }
                    } else {
                        Picker("Centimetres", selection: $answers.heightCm) { ForEach(100...230, id: \.self) { Text("\($0) cm").tag($0) } }
                    }
                }
                .pickerStyle(.wheel)
                .onChange(of: [answers.heightCm, answers.feet, answers.inches]) { answered.insert(.height) }
            } actions: {
                primary("Continue", id: "onboarding.continue") { save(.height) }.disabled(!answered.contains(.height))
            }
        case .weight:
            Page(symbol: "scalemass.fill", tint: .indigo, title: "What do you weigh?",
                 detail: "Weight shapes much of your plan. You can add it later.", progress: step, fromHealth: fromHealth.contains(.weight), message: message) {
                HStack(spacing: 0) {
                    Picker("Whole", selection: $answers.weightWhole) {
                        ForEach(usUnits ? 60...600 : 25...300, id: \.self) { Text(String($0)).tag($0) }
                    }
                    Picker("Tenths", selection: $answers.weightTenth) { ForEach(0...9, id: \.self) { Text(".\($0)").tag($0) } }
                    Text(usUnits ? "lb" : "kg").font(.title3).padding(.leading, 4)
                }
                .pickerStyle(.wheel)
            } actions: {
                primary("Continue", id: "onboarding.continue") { save(.weight) }
                secondary("Skip", id: "onboarding.skip") { advance(from: .weight) }
            }
        }
    }

    private func choice(_ label: String, value: String) -> some View {
        let selected = answers.sex == value
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
        return Button { answers.sex = value } label: {
            Text(label)
                .font(.title3.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 64)
                .foregroundStyle(selected ? Color.white : Color.primary)
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
            Text(title).font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6)
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

    private func begin() {
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
            _ = store.apply(.units(units))
        }
        prefill(from: HealthCharacteristics.none)
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
        connecting = false
        healthAsked = true
        let given = health.characteristics()
        // Label what Apple Health filled in (AC4): what the record lacked and Health gave.
        if profile?.sex == nil, given.sex != nil { fromHealth.insert(.sex) }
        if profile?.birthYear == nil, given.birthYear != nil { fromHealth.insert(.birth) }
        if heightBefore == nil, profile?.height != nil { fromHealth.insert(.height) }
        if weightBefore == nil, recordWeight != nil { fromHealth.insert(.weight) }
        prefill(from: given)
        advance(from: .health)
    }

    /// Fills the wheels from the record first, then from Apple Health, else sensible starts.
    private func prefill(from health: HealthCharacteristics) {
        answers.sex = profile?.sex ?? health.sex ?? answers.sex
        if let year = profile?.birthYear ?? health.birthYear {
            answers.birthYear = year
            answers.birthMonth = profile?.birthMonth ?? health.birthMonth ?? answers.birthMonth
            answered.insert(.birth)
        }
        if let feetInches = profile?.feetInches {
            answers.feet = feetInches.feet
            answers.inches = feetInches.inches
            answered.insert(.height)
        } else if let height = profile?.height.flatMap(Double.init) {
            answers.heightCm = Int(height.rounded())
            answered.insert(.height)
        }
        if let weight = recordWeight {
            answers.weightWhole = Int(weight)
            answers.weightTenth = Int(((weight - Double(Int(weight))) * 10).rounded()) % 10
        } else if usUnits, answers.weightWhole < 60 {
            answers.weightWhole = 160
        }
    }

    private var recordWeight: Double? { weightRow?.latest.flatMap { Double($0.value) } }

    private func save(_ step: OnboardingStep) {
        message = nil
        let result: RecordStore.ApplyResult
        switch step {
        case .health:
            return
        case .sex:
            guard let sex = answers.sex else { return }
            result = profile?.sex == sex ? .saved : store.apply(.profile(sex: sex))
        case .birth:
            result = profile?.birthYear == answers.birthYear && profile?.birthMonth == answers.birthMonth
                ? .saved : store.apply(.profile(birthYear: answers.birthYear, birthMonth: answers.birthMonth))
        case .height:
            if usUnits {
                let same = profile?.feetInches == MyData.FeetInches(feet: answers.feet, inches: answers.inches)
                result = same ? .saved : store.apply(.feetInches(feet: answers.feet, inches: answers.inches))
            } else {
                let same = profile?.height.flatMap(Double.init).map { Int($0.rounded()) } == answers.heightCm
                result = same ? .saved : store.apply(.profile(height: Double(answers.heightCm)))
            }
        case .weight:
            if recordWeight == weightAnswer {
                result = .saved
            } else {
                let added = store.apply(.add(metric: "weight", value: weightAnswer, day: DayText.iso(.now)))
                // Today already holds a weight: ask before replacing it (AC5, US-25 AC5).
                if case .refused(_, let existingId?) = added {
                    replacing = existingId
                    return
                }
                result = added
            }
        }
        settle(result, step)
    }

    private var weightAnswer: Double { Double(answers.weightWhole) + Double(answers.weightTenth) / 10 }

    /// "Replace it": a FHIR correction of today's weight, never a removal.
    private func replaceWeight() {
        guard let id = replacing else { return }
        replacing = nil
        settle(store.apply(.correct(id: id, value: weightAnswer)), .weight)
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

    /// The wheels' values. Defaults are a starting point the person moves from.
    struct Answers: Equatable {
        var sex: String?
        var birthYear = DayText.gregorian.component(.year, from: .now) - 40
        var birthMonth = 1
        var heightCm = 170
        var feet = 5
        var inches = 7
        var weightWhole = 70
        var weightTenth = 0
    }

    // MARK: Layout

    /// One onboarding screen: symbol, title, one line on why, the control, then the buttons.
    private struct Page<Content: View, Actions: View>: View {
        let symbol: String
        let tint: Color
        let title: String
        let detail: String
        let progress: OnboardingStep?
        var fromHealth = false
        var message: String?
        @ViewBuilder let content: () -> Content
        @ViewBuilder let actions: () -> Actions

        var body: some View {
            VStack(spacing: 0) {
                if let progress, let index = OnboardingStep.questions.firstIndex(of: progress) {
                    ProgressView(value: Double(index + 1), total: Double(OnboardingStep.questions.count))
                        .accessibilityLabel("Question \(index + 1) of \(OnboardingStep.questions.count)")
                        .padding(.bottom, 12)
                }
                ScrollView {
                    VStack(spacing: 14) {
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
                        content().padding(.top, 12)
                    }
                    .frame(maxWidth: .infinity)
                }
                .scrollBounceBehavior(.basedOnSize)
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
