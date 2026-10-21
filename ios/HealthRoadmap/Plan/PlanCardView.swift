import SwiftUI

/// One card of the plan: a single suggestion, or a grouped card holding two or
/// more of one category (the web's `GroupedSuggestionCard` in ResultsPanel.tsx).
struct PlanCardView: View {
    let card: PlanCard

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
                    SuggestionRow(suggestion: suggestion, showsIcon: false)
                }
            } else if let suggestion = card.suggestions.first {
                SuggestionRow(suggestion: suggestion, showsIcon: true)
            }
        }
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

/// A suggestion's title and two lines; a tap opens everything the web shows:
/// the full text, ingredients, guideline tags, the reason and the references.
private struct SuggestionRow: View {
    let suggestion: Suggestion
    let showsIcon: Bool
    @State private var expanded = false

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

            if expanded {
                SuggestionDetails(suggestion: suggestion)
                    .padding(.leading, showsIcon ? 54 : 0)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(16)
    }
}

/// The parts of a suggestion behind the tap. Links open in the browser.
private struct SuggestionDetails: View {
    let suggestion: Suggestion

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let ingredients = suggestion.ingredients, !ingredients.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(ingredients, id: \.self) { ingredient in
                        Label(ingredient, systemImage: "circle.fill")
                            .labelStyle(BulletLabelStyle())
                    }
                }
                .font(.subheadline)
            }
            if let guidelines = suggestion.guidelines, !guidelines.isEmpty {
                FlowTags(tags: guidelines)
            }
            if let reason = suggestion.reason {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Why this suggestion?").font(.subheadline.weight(.semibold))
                    Text(reason).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            if let references = suggestion.references, !references.isEmpty {
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
        .frame(maxWidth: .infinity, alignment: .leading)
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
            Text(priority == "urgent" ? "Urgent" : "Attention")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .background((priority == "urgent" ? Color.red : Color.orange).opacity(0.15), in: Capsule())
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
