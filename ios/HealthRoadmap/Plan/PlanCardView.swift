import SwiftUI

/// One card of the plan: a single suggestion, or a grouped card holding two or
/// more of one category (the web's `GroupedSuggestionCard` in ResultsPanel.tsx).
struct PlanCardView: View {
    let card: PlanCard
    /// Opens "Do you drink alcohol?" (US-60); only the reduce-alcohol suggestion offers it.
    var askAboutAlcohol: AlcoholQuestion? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if card.suggestions.count > 1 {
                HStack(spacing: 12) {
                    CategoryIcon(category: card.category)
                    Text(card.category.replacingOccurrences(of: "_", with: " ").capitalized)
                        .font(.headline)
                    Spacer()
                    PriorityBadge(priority: card.priority)
                }
                .padding([.horizontal, .top], 16)
                .padding(.bottom, 4)
                ForEach(card.suggestions) { suggestion in
                    Divider().padding(.leading, 16)
                    SuggestionRow(suggestion: suggestion, showsIcon: false, dismiss: dismiss(for: suggestion))
                }
            } else if let suggestion = card.suggestions.first {
                SuggestionRow(suggestion: suggestion, showsIcon: true, dismiss: dismiss(for: suggestion))
            }
        }
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    /// The Dismiss action, on the reduce-alcohol suggestion only (US-60): no other card can be dismissed.
    func dismiss(for suggestion: Suggestion) -> AlcoholQuestion? {
        suggestion.id == Suggestion.reduceAlcohol ? askAboutAlcohol : nil
    }
}

/// "Do you drink alcohol?" (US-60): called at Dismiss's tap, it records the screen then
/// and returns the save for the answer. Web twin: widget-src/src/components/AlcoholQuestion.tsx.
typealias AlcoholQuestion = @MainActor () -> (MyData.Alcohol) -> Void

/// A suggestion's title and two lines; a tap opens everything the web shows:
/// the full text, ingredients, guideline tags, the reason and the references.
private struct SuggestionRow: View {
    let suggestion: Suggestion
    let showsIcon: Bool
    /// Shown as a Dismiss button under the text when set.
    let dismiss: AlcoholQuestion?
    @State private var expanded = false
    /// The open question's save, so its dialog's arrow points at this Dismiss.
    @State private var answer: ((MyData.Alcohol) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(.spring(duration: 0.35, bounce: 0.2)) { expanded.toggle() }
            } label: {
                HStack(alignment: .top, spacing: 14) {
                    if showsIcon { CategoryIcon(category: suggestion.category) }
                    VStack(alignment: .leading, spacing: 6) {
                        Text(suggestion.title)
                            .font(.headline)
                            .foregroundStyle(.primary)
                        Text(suggestion.description)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(expanded ? nil : 2)
                            // Snaps to its full length on this row's own toggle: reflowing text
                            // inside the spring drew half-wrapped lines (Brad, 2026-10-23). Scoped to
                            // `expanded`, so rows below still slide whole when another opens.
                            .transaction(value: expanded) { $0.animation = nil }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                        .padding(.top, 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle())
            .sensoryFeedback(.selection, trigger: expanded)
            .accessibilityHint(expanded ? "Collapses the details" : "Shows the details")
            .accessibilityIdentifier("plan.suggestion")

            if let product = suggestion.usProduct {
                USProductBlock(block: product)
                    .padding(.leading, showsIcon ? 54 : 0)
            }

            if let dismiss {
                Button("Dismiss") { answer = dismiss() }
                    .font(.subheadline.weight(.medium))
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .confirmationDialog("Do you drink alcohol?", isPresented: Binding(get: { answer != nil }, set: { if !$0 { answer = nil } }), titleVisibility: .visible, presenting: answer) { save in
                        ForEach(MyData.Alcohol.allCases, id: \.self) { choice in Button(choice.label) { save(choice) } }
                    } message: { _ in
                        Text("Your answer is kept in your record, so your plan follows it on every device. You can change it in My data, under About you.")
                    }
                    .padding(.leading, showsIcon ? 54 : 0)
                    .accessibilityHint("Asks whether you drink alcohol")
                    .accessibilityIdentifier("plan.dismissAlcohol")
            }

            if expanded {
                SuggestionDetails(suggestion: suggestion)
                    .padding(.leading, showsIcon ? 54 : 0)
                    // Fades in below the text, never sliding up over the card being read.
                    .transition(.opacity)
            }
        }
        .padding(16)
        // The rows below slide while this one grows: clipped to its own frame, the
        // opened text is revealed, never drawn over the next suggestion.
        .clipped()
    }
}

/// Dr Brad's product for a supplement card (US-61), the engine's words and link: a quiet
/// inset under the card's text, its link opening the product page in the browser, as every
/// link in the plan does.
private struct USProductBlock: View {
    let block: USProducts.Block

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(block.name)
                .font(.subheadline.weight(.semibold))
            Text(block.line)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Link(destination: block.url) {
                Label(block.url.host() ?? block.name, systemImage: "arrow.up.right.square")
                    .font(.footnote.weight(.medium))
            }
            .accessibilityLabel("\(block.name) on \(block.url.host() ?? "its website")")
            .accessibilityHint("Opens in your browser")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("plan.usProduct")
    }
}

/// The parts of a suggestion behind the tap. Links open in the browser.
private struct SuggestionDetails: View {
    let suggestion: Suggestion

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let link = suggestion.link {
                // The web links the title; a tap on the title here opens the card, so the link sits inside.
                Link(destination: link) {
                    Label("View product", systemImage: "arrow.up.right.square")
                        .font(.subheadline.weight(.medium))
                }
            }
            if let ingredients = suggestion.ingredients, !ingredients.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(ingredients, id: \.self) { ingredient in
                        Label(ingredient, systemImage: "circle.fill")
                            .labelStyle(BulletLabelStyle())
                    }
                }
                .font(.subheadline)
            }
            EvidenceDetails(reason: suggestion.reason, guidelines: suggestion.guidelines ?? [], references: suggestion.references ?? [],
                            heading: "Why this suggestion?")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The evidence behind a suggestion or a summary tile, as the web shows it: guideline
/// tags, the reason, then the references, which open in the browser.
struct EvidenceDetails: View {
    let reason: String?
    let guidelines: [String]
    let references: [Suggestion.Reference]
    /// Over the reason, when the screen around it does not already say what it is.
    var heading: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !guidelines.isEmpty { FlowTags(tags: guidelines) }
            if let reason {
                VStack(alignment: .leading, spacing: 4) {
                    if let heading { Text(heading).font(.subheadline.weight(.semibold)) }
                    Text(reason).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            if !references.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(references, id: \.url) { reference in
                        Link(destination: reference.url) {
                            Label(reference.label, systemImage: "arrow.up.right.square")
                                .font(.footnote)
                                .multilineTextAlignment(.leading)
                        }
                    }
                }
            }
        }
    }
}

/// Guideline tags as small capsules that wrap onto new lines.
private struct FlowTags: View {
    let tags: [String]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { chips }
            VStack(alignment: .leading, spacing: 6) { chips }
        }
    }

    private var chips: some View {
        ForEach(tags, id: \.self) { tag in
            Text(tag)
                .font(.caption.weight(.medium))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Color.accentColor.opacity(0.12), in: Capsule())
                .foregroundStyle(Color.accentColor)
        }
    }
}

/// A small dot before an ingredient.
private struct BulletLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            configuration.icon.font(.system(size: 5)).foregroundStyle(.secondary)
            configuration.title
        }
    }
}

/// The badge on a grouped card when it holds something above "info".
private struct PriorityBadge: View {
    let priority: String

    var body: some View {
        if priority != "info" {
            StatusCapsule(label: priority == "urgent" ? "Urgent" : "Attention", tone: priority)
        }
    }
}

/// The category's symbol on a tinted square.
struct CategoryIcon: View {
    let category: String

    var body: some View {
        let (symbol, tint) = Self.style(for: category)
        Image(systemName: symbol)
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: 40, height: 40)
            .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityHidden(true)
    }

    static func style(for category: String) -> (symbol: String, tint: Color) {
        switch category {
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
}

/// A gentle press: the row sinks a little under the finger.
struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.spring(duration: 0.25), value: configuration.isPressed)
    }
}
