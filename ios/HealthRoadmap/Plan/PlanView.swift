import SwiftUI

/// The plan screen (US-25 AC2, AC6): the user's own record, planned on the phone
/// by the shared engine and laid out by the web's own `planSections`. It plans
/// again whenever the record changes.
struct PlanView: View {
    private enum LoadState {
        case loading
        case loaded(sections: [PlanSection], planMs: Double)
        /// The engine cannot plan this record yet, in its own words.
        case cannotPlan(String)
    }

    let engine: HealthEngine
    let store: RecordStore
    /// Switches to the My data tab.
    let showMyData: () -> Void
    @State private var state = LoadState.loading

    var body: some View {
        Group {
            switch state {
            case .loading:
                ProgressView()
            case .cannotPlan(let reason):
                ContentUnavailableView {
                    Label("Your plan needs a few details", systemImage: "person.text.rectangle")
                } description: {
                    Text(reason)
                } actions: {
                    Button("Go to My data", action: showMyData)
                        .buttonStyle(.borderedProminent)
                }
            case .loaded(let sections, let planMs):
                PlanList(sections: sections, planMs: planMs)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
        .task(id: store.recordJSON) { state = load(store.recordJSON) }
    }

    private func load(_ record: String) -> LoadState {
        let clock = ContinuousClock()
        do {
            let start = clock.now
            let json = try engine.plan(recordJSON: record, now: .now, deviceId: store.deviceId)
            let elapsed = clock.now - start
            let sections = try engine.sections(planJSON: json)
            let ms = Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15
            return .loaded(sections: sections, planMs: ms)
        } catch HealthEngine.EngineError.callFailed(let why) where why.hasPrefix("PlanError: ") {
            // health-core's one PlanError: no usable height or sex (plan.ts). Its own
            // words are written for connectors, so people get a plain sentence.
            return .cannotPlan("Add your sex and height on My data, and your plan appears here.")
        } catch {
            return .cannotPlan(error.localizedDescription)
        }
    }
}

/// The plan's sections, which rise in as they scroll into view, then the disclaimer
/// and the privacy line.
private struct PlanList: View {
    let sections: [PlanSection]
    let planMs: Double

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 28) {
                ForEach(sections) { section in
                    VStack(alignment: .leading, spacing: 12) {
                        Text(section.title)
                            .font(.title3.weight(.semibold))
                            .padding(.horizontal, 4)
                        ForEach(section.cards) { PlanCardView(card: $0) }
                    }
                    // Each section rises in as it scrolls into view. Driven by scroll position,
                    // not an appear flag: inside a navigation stack the flag's animation
                    // never ran, and the plan stayed invisible.
                    .scrollTransition(topLeading: .identity, bottomTrailing: .animated(.spring(duration: 0.6, bounce: 0.25))) { content, phase in
                        content
                            .opacity(phase.isIdentity ? 1 : 0)
                            .offset(y: phase.isIdentity ? 0 : 24)
                    }
                }

                // Same words as the web's disclaimer (ResultsPanel.tsx, `health-disclaimer`).
                Text("**Disclaimer:** This tool is for educational purposes only and is not a substitute for professional medical advice. Always consult with your healthcare provider before making any health decisions. Suggestions are based on general guidelines and may not apply to your individual situation.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)

                // Chat and lab upload send data (US-52 AC9, architecture.md D9), so the
                // line claims only where the plan was worked out.
                Label {
                    Text("Worked out on this iPhone in \(planMs.formatted(.number.precision(.fractionLength(1)))) ms.")
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
    }
}
