import SwiftUI

/// The plan screen (US-25 AC2): the record's plan, computed on the phone by the
/// shared engine, rendered natively. For the spike it shows the sample record.
struct PlanView: View {
    private enum LoadState {
        case loading
        case loaded(Plan, planMs: Double)
        case failed(String)
    }

    @State private var state = LoadState.loading

    var body: some View {
        NavigationStack {
            Group {
                switch state {
                case .loading:
                    ProgressView()
                case .failed(let message):
                    ContentUnavailableView("No plan", systemImage: "exclamationmark.triangle", description: Text(message))
                case .loaded(let plan, let planMs):
                    PlanContent(plan: plan, planMs: planMs)
                }
            }
            .background(Color(.systemGroupedBackground))
        }
        .task { state = Self.load() }
    }

    private static func load() -> LoadState {
        let clock = ContinuousClock()
        do {
            let engine = try HealthEngine()
            guard let url = Bundle.main.url(forResource: "sample-record", withExtension: "json") else {
                throw HealthEngine.EngineError.missingBundle
            }
            let record = try String(contentsOf: url, encoding: .utf8)
            let start = clock.now
            let json = try engine.plan(recordJSON: record, now: .now, deviceId: "ios-spike")
            let elapsed = clock.now - start
            let plan = try JSONDecoder().decode(Plan.self, from: Data(json.utf8))
            let ms = Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15
            return .loaded(plan, planMs: ms)
        } catch {
            return .failed(error.localizedDescription)
        }
    }
}

private struct PlanContent: View {
    let plan: Plan
    let planMs: Double
    @State private var appeared = false

    private var sections: [(title: String, subtitle: String, items: [Plan.Suggestion])] {
        let all = plan.results.suggestions
        return [
            ("Act now", "Talk to your doctor soon", all.filter { $0.priority == "urgent" }),
            ("Worth your attention", "The changes that matter most for you", all.filter { $0.priority == "attention" }),
            ("Your foundations", "Habits that keep you well", all.filter { $0.priority == "info" }),
        ].filter { !$0.items.isEmpty }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 28) {
                PlanHeader(plan: plan)

                ForEach(Array(sections.enumerated()), id: \.offset) { index, section in
                    VStack(alignment: .leading, spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(section.title).font(.title3.weight(.semibold))
                            Text(section.subtitle).font(.subheadline).foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 4)
                        ForEach(section.items) { SuggestionCard(suggestion: $0) }
                    }
                    .opacity(appeared ? 1 : 0)
                    .offset(y: appeared ? 0 : 24)
                    .animation(.spring(duration: 0.6, bounce: 0.25).delay(0.08 * Double(index + 1)), value: appeared)
                }

                Label {
                    Text("Worked out on this iPhone in \(planMs.formatted(.number.precision(.fractionLength(1)))) ms. Nothing left your device.")
                } icon: {
                    Image(systemName: "lock.shield")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.top, 8)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .onAppear { appeared = true }
    }
}

private struct PlanHeader: View {
    let plan: Plan

    private var actionCount: Int {
        plan.results.suggestions.filter { $0.priority != "info" }.count
    }

    private var dateLine: String {
        let parser = DateFormatter()
        parser.calendar = Calendar(identifier: .gregorian)
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.dateFormat = "yyyy-MM-dd"
        guard let day = parser.date(from: plan.today) else { return plan.today }
        return day.formatted(.dateTime.weekday(.wide).day().month(.wide))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(dateLine.uppercased())
                .font(.caption.weight(.semibold))
                .tracking(1.2)
                .foregroundStyle(.white.opacity(0.75))
            Text("Your plan")
                .font(.system(.largeTitle, design: .serif).weight(.semibold))
                .foregroundStyle(.white)
            Text(actionCount == 0 ? "Nothing needs your attention today." :
                    "\(actionCount) \(actionCount == 1 ? "thing" : "things") worth acting on, and the habits behind them.")
                .font(.callout)
                .foregroundStyle(.white.opacity(0.9))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(24)
        .background {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(LinearGradient(colors: [Color(red: 0.11, green: 0.33, blue: 0.36), Color(red: 0.19, green: 0.52, blue: 0.47)],
                                     startPoint: .topLeading, endPoint: .bottomTrailing))
                .overlay(alignment: .topTrailing) {
                    Image(systemName: "heart.text.square")
                        .font(.system(size: 110, weight: .ultraLight))
                        .foregroundStyle(.white.opacity(0.08))
                        .offset(x: 18, y: -12)
                }
                .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        }
        .padding(.top, 8)
    }
}

private struct SuggestionCard: View {
    let suggestion: Plan.Suggestion
    @State private var expanded = false

    private var style: (symbol: String, tint: Color) {
        switch suggestion.category {
        case "nutrition": ("fork.knife", .green)
        case "exercise": ("figure.run", .orange)
        case "bloodwork": ("drop.fill", .red)
        case "blood_pressure": ("heart.fill", .pink)
        case "sleep": ("moon.zzz.fill", .indigo)
        case "medication": ("pills.fill", .teal)
        case "screening": ("stethoscope", .blue)
        case "supplements": ("leaf.fill", .mint)
        case "skin": ("sun.max.fill", .yellow)
        default: ("sparkles", .purple)
        }
    }

    var body: some View {
        Button {
            withAnimation(.spring(duration: 0.35, bounce: 0.2)) { expanded.toggle() }
        } label: {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: style.symbol)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(style.tint)
                    .frame(width: 40, height: 40)
                    .background(style.tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 6) {
                    Text(suggestion.title)
                        .font(.headline)
                        .foregroundStyle(.primary)
                    Text(suggestion.description)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(expanded ? nil : 2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(expanded ? 180 : 0))
                    .padding(.top, 4)
            }
            .padding(16)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .buttonStyle(PressableStyle())
        .sensoryFeedback(.selection, trigger: expanded)
        .accessibilityHint(expanded ? "Collapses the details" : "Shows the details")
    }
}

/// A gentle press: the card sinks a little under the finger.
private struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(duration: 0.25), value: configuration.isPressed)
    }
}

/// The slice of the engine's plan this screen shows. The engine owns the full shape
/// (packages/health-core/src/plan.ts); unknown fields are ignored.
struct Plan: Decodable {
    struct Suggestion: Decodable, Identifiable {
        let id: String
        let category: String
        let priority: String
        let title: String
        let description: String
    }

    struct Results: Decodable {
        let suggestions: [Suggestion]
    }

    let today: String
    let results: Results
}
