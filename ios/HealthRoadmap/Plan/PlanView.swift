import SwiftUI

/// The plan screen (US-25 AC2): the record's plan, computed on the phone by the
/// shared engine and laid out by the web's own `planSections`. For the spike it
/// shows the sample record.
struct PlanView: View {
    private enum LoadState {
        case loading
        case loaded(today: String, sections: [PlanSection], planMs: Double)
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
                case .loaded(let today, let sections, let planMs):
                    PlanList(today: today, sections: sections, planMs: planMs)
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
            let sections = try engine.sections(planJSON: json)
            let ms = Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15
            return .loaded(today: plan.today, sections: sections, planMs: ms)
        } catch {
            return .failed(error.localizedDescription)
        }
    }
}

/// The plan's sections, which float in one after another, then the disclaimer
/// and the privacy line.
private struct PlanList: View {
    let today: String
    let sections: [PlanSection]
    let planMs: Double
    @State private var appeared = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 28) {
                // The web titles this column "Your plan to discuss with your doctor".
                Text("To discuss with your doctor · \(Self.dateLine(today))")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)

                ForEach(Array(sections.enumerated()), id: \.element.id) { index, section in
                    VStack(alignment: .leading, spacing: 12) {
                        Text(section.title)
                            .font(.title3.weight(.semibold))
                            .padding(.horizontal, 4)
                        ForEach(section.cards) { PlanCardView(card: $0) }
                    }
                    .opacity(appeared ? 1 : 0)
                    .offset(y: appeared ? 0 : 24)
                    .animation(.spring(duration: 0.6, bounce: 0.25).delay(0.08 * Double(index)), value: appeared)
                }

                // Same words as the web's disclaimer (ResultsPanel.tsx, `health-disclaimer`).
                Text("**Disclaimer:** This tool is for educational purposes only and is not a substitute for professional medical advice. Always consult with your healthcare provider before making any health decisions. Suggestions are based on general guidelines and may not apply to your individual situation.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)

                // True while the app has no network code (architecture.md D9); re-check it
                // when the first network call lands.
                Label {
                    Text("Worked out on this iPhone in \(planMs.formatted(.number.precision(.fractionLength(1)))) ms. No health data left your device.")
                } icon: {
                    Image(systemName: "lock.shield")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
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
