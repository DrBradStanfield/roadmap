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

    /// Only these: the flow's state is its own, so no caller starts it on a step (PR 1512 review R3).
    init(store: RecordStore, health: AppleHealthSync, onlyMissing: Bool, keepUnits: Bool, finish: @escaping () -> Void) {
        self.store = store
        self.health = health
        self.onlyMissing = onlyMissing
        self.keepUnits = keepUnits
        self.finish = finish
    }

    /// A setting, not health data: the Apple Health screen was answered once.
    @AppStorage("onboardingHealthAsked") var healthAsked = false
    /// The flow's one named state (S6): starting, connecting, a page with its save, finished
    /// (holding the last page).
    @State var mode = OnboardingFlow.Mode.starting
    @State var answers = Answers()
    /// The steps Apple Health filled in, by name only, kept so a relaunch keeps AC3b's guards
    /// (adversary R2); cleared when the flow starts at Apple Health or finishes.
    @AppStorage("onboardingFromHealth") var fromHealthNames = ""
    @State var fromHealth: Set<OnboardingStep> = []
    /// What Apple Health supplied, not asked and listed on the last screen (AC3b): worked out
    /// from the record when it or `fromHealth` changes, not on every draw.
    @State var supplied: Set<OnboardingStep> = []
    /// Health gave a weight more than a year old (AC3b, guard a): Continue on it saves it as
    /// today's. Once saved it is today's, so no longer stale (adversary R1).
    var staleWeight: Bool { fromHealth.contains(.weight) && !supplied.contains(.weight) }
    @FocusState var focus: Field?
    @Environment(\.dynamicTypeSize) private var typeSize
    /// The engine's words for the last try, shown under the question.
    private var message: String? { mode.save?.message }
    /// An answer is being saved, Apple Health is answering, or the flow is done: the page waits.
    private var busy: Bool { mode.save?.busy ?? true }

    var profile: MyData.Profile? { store.myData?.profile }
    /// The units the engine's edits read: the record's for height, weight's own for weight,
    /// which may differ from the record's (US-25 AC17e, adversary R1).
    func recordUnits(_ step: OnboardingStep) -> String {
        step == .weight ? store.units(for: "weight") : store.myData?.unitSystem ?? "si"
    }
    var weightRow: MyData.Row? { store.myData?.vitals.first { $0.metric == "weight" } }

    var body: some View {
        NavigationStack {
            Group {
                if let step = mode.step {
                    page(step)
                        .disabled(busy)
                        .id(step)
                        .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)).combined(with: .opacity))
                } else if mode == .starting {
                    ProgressView()
                }
            }
            // The NavigationStack paints its own background over the cover's (RootView), so the
            // launch screen's colour is set again inside it (US-25 AC21b).
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(.systemGroupedBackground), ignoresSafeAreaEdges: .all)
            .toolbar {
                if let page = mode.page, let back = previous(page) {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Back", systemImage: "chevron.left") { send(.moved(back)) }
                            .disabled(busy)
                            .accessibilityIdentifier("onboarding.back")
                    }
                }
            }
        }
        .interactiveDismissDisabled()
        .task { await begin() }
        // Kept by name only, so a relaunch keeps AC3b's guards (adversary R2).
        .onChange(of: fromHealth) { fromHealthNames = OnboardingSteps.encode(fromHealth); noteSupplied() }
        .onChange(of: store.revision) { noteSupplied() }
        // Pinned when the first page showed and given back on finishing; a run that never began never pinned.
        .onDisappear { if mode.pinned { store.unpinScreen() } }
        .confirmationDialog("Today already has a weight", isPresented: Binding(get: { mode.save?.held != nil }, set: { if !$0 { send(.declined) } }),
                            titleVisibility: .visible, presenting: mode.save?.held) { replace in
            Button("Replace it") { send(.confirmed(replace)) }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Replace today's weight with this one? The old value stays in your history, marked as replaced.")
        }
        .sensoryFeedback(.selection, trigger: mode.step) { _, step in step != nil }
    }

    // MARK: Pages

    @ViewBuilder private func page(_ step: OnboardingStep) -> some View {
        switch step {
        case .health:
            // Connecting, or done after it: the button stays as it was while the cover slides down.
            Self.healthPage(connecting: mode.save == nil) { send(.allowTapped) }
        case .sex:
            // A tap is the answer: it saves and moves on, so the step has no Continue (Brad 2026-10-23).
            OnboardingPage(symbol: "person.fill", tint: .accentColor, title: "What is your sex?",
                 detail: "Your plan's targets and screenings depend on it.", progress: step, fromHealth: fromHealth.contains(.sex), message: message) {
                HStack(spacing: 12) {
                    choice(MyData.sexLabel("female"), value: "female")
                    choice(MyData.sexLabel("male"), value: "male")
                }
            }
        case .birth:
            OnboardingPage(symbol: "calendar", tint: .orange, title: "When were you born?",
                 detail: "Your age decides which checks you're due for, like bowel and breast cancer screening and bone density (DEXA) scans. We never ask for the day.",
                 progress: step, fromHealth: fromHealth.contains(.birth), message: message) {
                HStack(spacing: 0) {
                    Picker("Month", selection: $answers.birthMonth) {
                        ForEach(DayText.birthMonths(year: answers.birthYear, now: .now), id: \.self) { Text(DayText.monthName($0)).tag($0) }
                    }
                    Picker("Year", selection: $answers.birthYear) {
                        ForEach(Self.birthYears, id: \.self) { Text(String($0)).tag($0) }
                    }
                }
                .pickerStyle(.wheel)
                .onChange(of: [answers.birthMonth, answers.birthYear]) {
                    answers.birthAnswered = true
                    // This year's wheel stops at this month (US-54 AC5b): a later month moves back to it.
                    answers.birthMonth = min(answers.birthMonth, DayText.latestBirthMonth(year: answers.birthYear, now: .now))
                }
            } actions: {
                Self.primary("Continue", id: "onboarding.continue") { send(.tapped) }.disabled(!answers.birthAnswered)
            }
        case .height:
            OnboardingPage(symbol: "ruler", tint: .teal, title: "How tall are you?",
                 detail: "Height sets your healthy weight range.", progress: step, fromHealth: fromHealth.contains(.height), message: message ?? answers.height.question) {
                withUnits(.height) {
                    if answers.height.us {
                        numberField(.feet)
                        numberField(.inches)
                    } else {
                        numberField(.height)
                    }
                }
            } actions: {
                Self.primary("Continue", id: "onboarding.continue") { send(.tapped) }
                    .disabled(answers.height.value == nil)
            }
        case .weight:
            // Required (Brad 2026-10-23): weight shapes much of the plan, so there is no Skip.
            OnboardingPage(symbol: "scalemass.fill", tint: .indigo, title: "What do you weigh?",
                 detail: "Weight shapes much of your plan.", progress: step, fromHealth: fromHealth.contains(.weight), message: message ?? answers.weight.question) {
                withUnits(.weight) {
                    numberField(.weight)
                }
            } actions: {
                Self.primary("Continue", id: "onboarding.continue") { send(.tapped) }
                    .disabled(answers.weight.value == nil)
            }
        case .review:
            // One tap to accept what Apple Health gave, so a wrong entry is caught (AC3b, guard b).
            OnboardingPage(symbol: "heart.fill", tint: .pink, title: "From Apple Health",
                 detail: "Check these are right. Tap Edit to change one.", progress: nil) {
                let lines = summaryLines
                VStack(spacing: 0) {
                    ForEach(lines, id: \.step) { line in
                        if line.step != lines.first?.step { Divider() }
                        // Stacked at accessibility sizes, so a long answer never squeezes Edit (adversary R7).
                        LabelValue.layout(typeSize).callAsFunction {
                            Text(line.text).font(.title3).accessibilityLabel(line.spoken)
                            Spacer(minLength: 0)
                            Button("Edit") { send(.moved(.init(step: line.step, fromSummary: true))) }
                                .accessibilityLabel("Edit \(line.step.name)")
                                .accessibilityIdentifier("onboarding.edit.\(line.step)")
                        }
                        .padding(.vertical, 12)
                    }
                }
                .padding(.horizontal, 16)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            } actions: {
                Self.primary("Continue", id: "onboarding.continue") { send(.reviewAccepted) }
            }
        }
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
            send(.wordsStale)
        })
    }

    func answer(_ step: OnboardingStep) -> TypedAnswer { step == .weight ? answers.weight : answers.height }

    /// The box a typed screen focuses, on arrival and after its unit switch.
    func firstField(_ step: OnboardingStep) -> Field {
        step == .weight ? .weight : answers.height.us ? .feet : .height
    }

    private func choice(_ label: String, value: String) -> some View {
        let selected = answers.sex == value
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
        // The tap that claims the save picks the answer; one while it saves changes nothing.
        return Button { if !busy { answers.sex = value }; send(.tapped) } label: {
            Text(label)
                .font(.title3.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 64)
                .foregroundStyle(selected ? Color.onAccent : Color.primary)
                .background(selected ? Color.accentColor : Color(.secondarySystemGroupedBackground), in: shape)
                .contentShape(shape)
        }
        .buttonStyle(.plain)
        .animation(.snappy, value: selected)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("onboarding.\(value)")
    }

    static func primary(_ title: String, id: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(.accent)
            .accessibilityIdentifier(id)
    }

    /// Built once: the wheels redraw on every tick.
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
        /// Birth has an answer: from the record, from Apple Health, or a wheel the person
        /// moved. A wheel's starting value is never taken as an answer (AC4). Height and
        /// weight are typed: their answer is a number in the box.
        var birthAnswered = false
    }

    enum Field: String { case height, feet, inches, weight }
}
