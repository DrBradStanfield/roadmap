import SwiftUI

/// The Apple Health step's picture (Brad 2026-10-23: "needs some magic and
/// delight"): the six things the app reads light up one by one, each ticked as
/// if filled in, with a line under them naming the two taps on Apple's sheet that
/// comes next. That sheet is the system's: an app cannot turn its switches on, so
/// this offers no switch of its own, only the way through. Loops; under Reduce
/// Motion it shows everything ticked and still. VoiceOver reads the six as one list.
struct HealthFillScene: View {
    @State private var filled = 0
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
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Apple Health fills in six things: \(Self.items.map { $0.name.lowercased() }.joined(separator: ", ")).")

            Text("Apple asks next: tap **Turn On All**, then **Allow**.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
        }
        .task { await play() }
    }

    private func tile(_ item: (symbol: String, tint: Color, name: String), lit: Bool) -> some View {
        VStack(spacing: 6) {
            Image(systemName: item.symbol)
                .font(.title3)
                .foregroundStyle(lit ? item.tint.softInDark : Color.secondary.opacity(0.5))
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

    /// Ticks the tiles one by one, holds, then starts again.
    private func play() async {
        if reduceMotion {
            filled = Self.items.count
            return
        }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(0.5))
            for index in 1...Self.items.count {
                withAnimation(.spring(duration: 0.4, bounce: 0.4)) { filled = index }
                try? await Task.sleep(for: .seconds(0.28))
            }
            try? await Task.sleep(for: .seconds(2.9))
            withAnimation(.easeOut(duration: 0.4)) { filled = 0 }
        }
    }
}

#Preview { HealthFillScene().padding() }
