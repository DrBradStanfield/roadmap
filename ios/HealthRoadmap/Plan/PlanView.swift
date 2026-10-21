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
                    PlanList(plan: plan, planMs: planMs)
                }
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Your plan")
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

/// The plan's groups, which float in one after another, and the privacy footer.
private struct PlanList: View {
    let plan: Plan
    let planMs: Double
    @State private var appeared = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 28) {
                Text(Self.dateLine(plan.today))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)

                ForEach(Array(PlanSection.sections(for: plan.results.suggestions).enumerated()), id: \.element.id) { index, section in
                    VStack(alignment: .leading, spacing: 12) {
                        Text(section.title)
                            .font(.title3.weight(.semibold))
                            .padding(.horizontal, 4)
                        ForEach(section.suggestions) { SuggestionCard(suggestion: $0) }
                    }
                    .opacity(appeared ? 1 : 0)
                    .offset(y: appeared ? 0 : 24)
                    .animation(.spring(duration: 0.6, bounce: 0.25).delay(0.08 * Double(index)), value: appeared)
                }

                Label {
                    Text("Worked out on this iPhone in \(planMs.formatted(.number.precision(.fractionLength(1)))) ms. No health data left your device.")
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

    /// "Wednesday 21 October" from the plan's YYYY-MM-DD.
    private static func dateLine(_ day: String) -> String {
        let parser = DateFormatter()
        parser.calendar = Calendar(identifier: .gregorian)
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.dateFormat = "yyyy-MM-dd"
        guard let date = parser.date(from: day) else { return day }
        return date.formatted(.dateTime.weekday(.wide).day().month(.wide))
    }
}
