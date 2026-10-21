import SwiftUI

/// The plan screen (US-25 AC2): the record's plan, computed on the phone by the
/// shared engine and laid out by the web's own `planSections`. For the spike it
/// shows the sample record.
struct PlanView: View {
    private enum LoadState {
        case loading
        case loaded(sections: [PlanSection], planMs: Double)
        case failed(String)
    }

    @State private var state = LoadState.loading

    var body: some View {
        // No title bar: the cards start at the top (Brad 2026-10-21). The
        // disclaimer at the end says to consult a healthcare provider.
        Group {
            switch state {
            case .loading:
                ProgressView()
            case .failed(let message):
                ContentUnavailableView("No plan", systemImage: "exclamationmark.triangle", description: Text(message))
            case .loaded(let sections, let planMs):
                PlanList(sections: sections, planMs: planMs)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
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
            let sections = try engine.sections(planJSON: json)
            let ms = Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15
            return .loaded(sections: sections, planMs: ms)
        } catch {
            return .failed(error.localizedDescription)
        }
    }
}

/// The plan's sections, which float in one after another, then the disclaimer
/// and the privacy line.
private struct PlanList: View {
    let sections: [PlanSection]
    let planMs: Double
    @State private var appeared = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 28) {
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
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .onAppear { appeared = true }
    }
}
