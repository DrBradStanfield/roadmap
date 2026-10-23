import SwiftUI

/// The Apple Health step's picture (Brad 2026-10-23: "needs some magic and
/// delight"): the six things the app reads light up one by one, each ticked as
/// if filled in, then a switch turns on beside "Turn On All", the button on
/// Apple's sheet that comes next. Apple's sheet is the system's: an app cannot
/// turn its switches on, so this points at the one tap that does. Loops; under
/// Reduce Motion it shows everything ticked and still. The hint is read by
/// VoiceOver; the tiles are not, the text above lists them.
struct HealthFillScene: View {
    @State private var filled = 0
    @State private var on = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let items: [(symbol: String, tint: Color, name: String)] = [
        ("person.fill", .orange, "Sex"),
        ("calendar", .red, "Birth date"),
        ("ruler.fill", .purple, "Height"),
        ("scalemass.fill", .purple, "Weight"),
        ("figure.arms.open", .purple, "Waist"),
        ("heart.fill", .red, "Blood pressure"),
    ]

    var body: some View {
        VStack(spacing: 18) {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10), GridItem(.flexible())], spacing: 10) {
                ForEach(Self.items.indices, id: \.self) { index in
                    tile(Self.items[index], lit: index < filled)
                }
            }
            .accessibilityHidden(true)

            HStack(spacing: 12) {
                Toggle("", isOn: .constant(on))
                    .labelsHidden()
                    .tint(.green)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                Text("On the next screen, tap **Turn On All** so your plan can use them.")
                    .font(.subheadline)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .padding(14)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .task { await play() }
    }

    private func tile(_ item: (symbol: String, tint: Color, name: String), lit: Bool) -> some View {
        VStack(spacing: 6) {
            Image(systemName: item.symbol)
                .font(.title3)
                .foregroundStyle(lit ? item.tint : Color.secondary.opacity(0.5))
                .symbolEffect(.bounce, value: lit)
                .frame(height: 26)
            Text(item.name)
                .font(.caption.weight(.medium))
                .foregroundStyle(lit ? .primary : .secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(alignment: .topTrailing) {
            if lit {
                Image(systemName: "checkmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(.green)
                    .padding(6)
                    .transition(.scale.combined(with: .opacity))
            }
        }
        .scaleEffect(lit || reduceMotion ? 1 : 0.96)
    }

    /// Ticks the tiles one by one, turns the switch on, holds, then starts again.
    private func play() async {
        if reduceMotion {
            filled = Self.items.count
            on = true
            return
        }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(0.5))
            for index in 1...Self.items.count {
                withAnimation(.spring(duration: 0.4, bounce: 0.4)) { filled = index }
                try? await Task.sleep(for: .seconds(0.28))
            }
            try? await Task.sleep(for: .seconds(0.3))
            withAnimation(.spring(duration: 0.35)) { on = true }
            try? await Task.sleep(for: .seconds(2.6))
            withAnimation(.easeOut(duration: 0.4)) {
                filled = 0
                on = false
            }
        }
    }
}

#Preview { HealthFillScene().padding() }
