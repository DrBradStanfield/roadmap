import SwiftUI

/// The plan screen (US-25 AC2, AC6): the user's own record, planned on the phone
/// by the shared engine and laid out by the web's own `planSections`. It plans
/// while on screen: on each return to the tab, and on every record change then.
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
    /// Plans only while on screen: a tab once opened stays alive, and re-planning on
    /// every My data edit behind it cost the main thread for nothing.
    @State private var visible = false

    var body: some View {
        // Read once per render, so the task runs once with the value its id names.
        let planKey = visible ? store.recordJSON : nil
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
        .onAppear { visible = true }
        .onDisappear {
            visible = false
            // Never show a plan from an older record on return, even for a frame.
            state = .loading
        }
        .task(id: planKey) {
            guard let planKey else { return }
            let (next, planned) = load(planKey)
            state = next
            // A downloaded engine on trial has planned the user's own record (US-25 AC18).
            // Never when it threw: that is the failure the trial exists to catch (review R5).
            if planned { engine.trial?.confirm() }
        }
    }

    /// The screen's state, and whether the engine planned the record: a plan, or
    /// health-core's own PlanError (no height or sex). Any other throw is not.
    private func load(_ record: String) -> (LoadState, planned: Bool) {
        let clock = ContinuousClock()
        do {
            let start = clock.now
            let json = try engine.plan(recordJSON: record, now: .now, deviceId: store.deviceId)
            let sections = try engine.sections(planJSON: json)
            // The whole plan: the engine's plan, its layout and their decoding (D2's budget).
            let elapsed = clock.now - start
            let ms = Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15
            return (.loaded(sections: sections, planMs: ms), true)
        } catch HealthEngine.EngineError.callFailed(let why) where why.hasPrefix("PlanError: ") {
            // health-core's one PlanError: no usable height or sex (plan.ts). Its own
            // words are written for connectors, so people get a plain sentence.
            return (.cannotPlan("Add your sex and height on My data, and your plan appears here."), true)
        } catch {
            return (.cannotPlan(error.localizedDescription), false)
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
