import SwiftUI

/// A My data section's title with one tinted symbol, as Apple Health colours its
/// categories (US-25 AC17d, Brad 2026-10-22: colour on the sections, not on every
/// reading). The charts' colours are each metric's own (MetricChart.colors).
struct SectionTitle: View {
    let title: String
    let symbol: String
    let tint: Color

    var body: some View {
        Label {
            Text(title)
        } icon: {
            Image(systemName: symbol).foregroundStyle(tint.softInDark)
        }
    }

    static func aboutYou() -> Self { Self(title: "About you", symbol: "person.crop.circle.fill", tint: .orange) }
    static func vitals() -> Self { Self(title: "Vitals", symbol: "heart.fill", tint: .red) }
    static func bloodTests() -> Self { Self(title: "Blood tests", symbol: "drop.fill", tint: .blue) }
    static func medications(_ title: String = "Medications") -> Self { Self(title: title, symbol: "pills.fill", tint: .teal) }
    static func screening(_ title: String = "Screening") -> Self { Self(title: title, symbol: "stethoscope", tint: .indigo) }
    static func supplements() -> Self { Self(title: "Supplements", symbol: "leaf.fill", tint: .green) }
    static func reminders() -> Self { Self(title: "Reminders", symbol: "bell.fill", tint: .orange) }
    static func appleHealth() -> Self { Self(title: "Apple Health", symbol: "heart.text.square.fill", tint: .pink) }
    static func record() -> Self { Self(title: "Your record", symbol: "folder.fill", tint: .gray) }
}
