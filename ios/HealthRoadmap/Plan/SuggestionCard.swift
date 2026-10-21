import SwiftUI

/// One suggestion. Shows the title and two lines; a tap opens the full text.
struct SuggestionCard: View {
    let suggestion: Plan.Suggestion
    @State private var expanded = false

    var body: some View {
        Button {
            withAnimation(.spring(duration: 0.35, bounce: 0.2)) { expanded.toggle() }
        } label: {
            HStack(alignment: .top, spacing: 14) {
                CategoryIcon(category: suggestion.category)
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

/// A gentle press: the card sinks a little under the finger.
struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(duration: 0.25), value: configuration.isPressed)
    }
}
