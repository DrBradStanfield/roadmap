import SwiftUI

/// The plan screen (US-25 AC2, AC6): the user's own record, planned on the phone
/// by the shared engine and laid out by the web's own `planSections`. The store keeps
/// the plan from the same engine call as My data, once per record change and again on
/// each return to the app, so this screen never asks the engine itself and always shows the record My
/// data shows.
/// The web twin is widget-src/src/components/ResultsPanel.tsx.
struct PlanView: View {
    let store: RecordStore
    /// Switches to the My data tab.
    let showMyData: () -> Void
    @State private var refusal: String?
    @Environment(\.analytics) private var analytics

    var body: some View {
        Group {
            switch store.plan {
            case .planned(let tiles, let sections, let ms):
                PlanList(tiles: tiles, sections: sections, planMs: ms, showMyData: showMyData, askAboutAlcohol: alcoholQuestion)
            case .needsDetails:
                // health-core's PlanError: its own words are written for connectors, so
                // people get a plain sentence.
                cannotPlan("Add your sex and height on My data, and your plan appears here.")
            case .failed(let reason):
                cannotPlan(reason)
            case nil:
                // The record cannot be read: its problem, in My data's words (adversary R3).
                ContentUnavailableView("Your record could not be opened", systemImage: "exclamationmark.triangle", description: Text(store.problem ?? ""))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
        // The save lands after an await, outside any withAnimation, so the plan animates
        // on the answer itself: the card "I don't drink" removes fades out and the rest
        // close up, with the spring a card opens with. Nothing else animates the plan.
        .animation(.spring(duration: 0.35, bounce: 0.2), value: store.myData?.profile.alcohol?.value)
        .refusalAlert($refusal)
    }

    /// Offered only while the question is unanswered: after "I drink" the card stays, without
    /// its Dismiss. Called at the tap, it checks the answer against the screen then, as a
    /// sheet's save is (RecordPin.swift), so an erase in between refuses it.
    private var alcoholQuestion: AlcoholQuestion? {
        guard store.myData?.profile.alcohol?.value == nil else { return nil }
        return { [store, analytics] in
            let seen = store.screen
            return { choice in
                Task {
                    switch await store.apply(.alcohol(choice), as: seen) {
                    case .saved: analytics?.event(.alcoholAnswered)
                    case .refused(let message, _): refusal = message
                    }
                }
            }
        }
    }

    /// The privacy line's words, with the engine's own whole milliseconds: a plan faster
    /// than its clock's tick reads 0, so "under 1 ms" (adversary R4).
    static func workedOut(ms: Double) -> String {
        ms < 1 ? "Worked out on this iPhone in under 1 ms."
            : "Worked out on this iPhone in \(ms.formatted(.number.precision(.fractionLength(0)))) ms."
    }

    private func cannotPlan(_ reason: String) -> some View {
        ContentUnavailableView {
            Label("Your plan needs a few details", systemImage: "person.text.rectangle")
        } description: {
            Text(reason)
        } actions: {
            Button(action: showMyData) { Text("Go to My data").onAccentLabel() }
                .buttonStyle(.borderedProminent)
        }
    }
}

/// The summary tiles, then the plan's sections, whose cards rise in as they scroll into
/// view, then the disclaimer and the privacy line.
struct PlanList: View {
    let tiles: [StatTile]
    let sections: [PlanSection]
    let planMs: Double
    let showMyData: () -> Void
    /// Asks "Do you drink alcohol?" (US-60); nil once it is answered.
    let askAboutAlcohol: AlcoholQuestion?

    var body: some View {
        ScrollViewReader { proxy in
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
                            ForEach(section.cards) { card in
                                // Tour tip 2 (US-57 AC6): the first Foundation step; its Next opens tip 3 on My data.
                                if section.isFoundation, card.id == section.cards.first?.id {
                                    PlanCardView(card: card, askAboutAlcohol: asksAboutAlcohol(card)).modifier(RiseIn())
                                        .id(Self.foundationCard)
                                        .tourTip(FoundationTip(), next: showMyData)
                                } else {
                                    PlanCardView(card: card, askAboutAlcohol: asksAboutAlcohol(card)).modifier(RiseIn())
                                }
                            }
                            // US-61 AC7: once, under the last Supplements card, when a card shows a product.
                            if let ownership = section.ownershipLine {
                                Text(ownership)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 4)
                                    .accessibilityIdentifier("plan.ownershipLine")
                            }
                        }
                    }

                    // Same words as the web's disclaimer (ResultsPanel.tsx, `health-disclaimer`).
                    Text("**Disclaimer:** This tool is for educational purposes only and is not a substitute for professional medical advice. Always consult with your healthcare provider before making any health decisions. Suggestions are based on general guidelines and may not apply to your individual situation.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 4)

                    // Chat and lab upload send data (US-52 AC9, architecture.md D9), so the
                    // line claims only where the plan was worked out, and how long the engine
                    // took to plan it, in its own whole milliseconds (D2's plan budget).
                    Label {
                        Text(PlanView.workedOut(ms: planMs))
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
            .task {
                // Tip 2 is due once tip 1 closes: bring its card into view, or it waits off screen.
                for await due in FoundationTip().shouldDisplayUpdates where due {
                    withAnimation { proxy.scrollTo(Self.foundationCard, anchor: .center) }
                }
            }
            // A plan with no tiles or no Foundation card cannot draw that tip: the tour
            // passes it (AC4, AC6; review R4).
            .tourStep(SnapshotTip(), hasNoAnchor: tiles.isEmpty)
            .tourStep(FoundationTip(), hasNoAnchor: !sections.contains { $0.isFoundation && !$0.cards.isEmpty })
        }
    }

    /// The question goes only to the card holding reduce-alcohol; the rest get nil, so they stay comparable.
    func asksAboutAlcohol(_ card: PlanCard) -> AlcoholQuestion? {
        card.suggestions.contains { $0.id == Suggestion.reduceAlcohol } ? askAboutAlcohol : nil
    }

    /// The scroll id of the Foundation section's first card.
    private static let foundationCard = "tour.foundation"
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
