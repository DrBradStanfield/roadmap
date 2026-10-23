import SwiftUI

/// The plan screen (US-25 AC2, AC6): the user's own record, planned on the phone
/// by the shared engine and laid out by the web's own `planSections`. It plans
/// while on screen: on each return to the tab, and on every record change then.
struct PlanView: View {
    private enum LoadState {
        case loading
        case loaded(tiles: [StatTile], sections: [PlanSection], planMs: Double)
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
        let planKey = visible ? PlanKey(record: store.recordJSON, units: store.unitChoices.json) : nil
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
                    Button(action: showMyData) { Text("Go to My data").onAccentLabel() }
                        .buttonStyle(.borderedProminent)
                }
            case .loaded(let tiles, let sections, let planMs):
                PlanList(tiles: tiles, sections: sections, planMs: planMs)
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
            let (next, planned) = await load(planKey)
            // The record moved on while the engine worked: the newer task draws it.
            guard !Task.isCancelled else { return }
            state = next
            // A downloaded engine on trial has planned the user's own record (US-25 AC18).
            // Never when it threw: that is the failure the trial exists to catch (review R5).
            if planned { engine.trial?.confirm() }
        }
    }

    /// The screen's state, and whether the engine planned the record: a plan, or
    /// health-core's own PlanError (no height or sex). Any other throw is not.
    /// What a plan is computed from: the record, and the per-test units its targets read in (AC17e).
    private struct PlanKey: Equatable { let record: String; let units: String }

    /// Off the main thread, on the engine's queue.
    private func load(_ key: PlanKey) async -> (LoadState, planned: Bool) {
        do {
            let plan = try await engine.planSections(record: key.record, units: key.units, now: .now, deviceId: store.deviceId)
            return (.loaded(tiles: plan.tiles, sections: plan.sections, planMs: plan.ms), true)
        } catch HealthEngine.EngineError.callFailed(let why) where why.hasPrefix("PlanError: ") {
            // health-core's one PlanError: no usable height or sex (plan.ts). Its own
            // words are written for connectors, so people get a plain sentence.
            return (.cannotPlan("Add your sex and height on My data, and your plan appears here."), true)
        } catch {
            return (.cannotPlan(error.localizedDescription), false)
        }
    }
}

/// The summary tiles, then the plan's sections, whose cards rise in as they scroll into
/// view, then the disclaimer and the privacy line.
private struct PlanList: View {
    let tiles: [StatTile]
    let sections: [PlanSection]
    let planMs: Double

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 28) {
                // The web's Quick Stats, above the suggestions as there (US-25 AC22).
                if !tiles.isEmpty { SummaryTiles(tiles: tiles) }

                ForEach(sections) { section in
                    VStack(alignment: .leading, spacing: 12) {
                        Text(section.title)
                            .font(.title3.weight(.semibold))
                            .padding(.horizontal, 4)
                            .modifier(RiseIn())
                        ForEach(section.cards) { PlanCardView(card: $0).modifier(RiseIn()) }
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

/// A card rises in the first time any of it scrolls into view, then stays (Brad 2026-10-23).
/// Once, per card: a section-wide transition tied to scroll position faded a section out
/// while it was being read, once an opened card made it taller than the screen
/// (Micronutrient base). Not an appear flag: inside a navigation stack its animation
/// never ran, and the plan stayed invisible. A card starts visible and is hidden only once
/// it is reported off screen, so one on screen at first, or one whose report never comes,
/// is never left at 0 (review R-N4). VoiceOver and Reduce Motion skip it: the cards are
/// simply there. iOS 18 and later; on 17 the cards are there from the start.
private struct RiseIn: ViewModifier {
    private enum Phase { case shown, waiting, risen }
    @State private var phase = Phase.shown
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver

    func body(content: Content) -> some View {
        // One view either way, so turning VoiceOver on keeps an opened card open.
        let hidden = phase == .waiting && !reduceMotion && !voiceOver
        if #available(iOS 18, *) {
            content
                .opacity(hidden ? 0 : 1)
                .offset(y: hidden ? 24 : 0)
                .onScrollVisibilityChange(threshold: 0.01) { visible in
                    switch (phase, visible) {
                    case (.shown, false): phase = .waiting
                    case (.shown, true): phase = .risen
                    case (.waiting, true): withAnimation(.spring(duration: 0.6, bounce: 0.25)) { phase = .risen }
                    default: break
                    }
                }
        } else {
            content
        }
    }
}
