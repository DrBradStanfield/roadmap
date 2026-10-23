import SwiftUI

/// A My data section's title with one tinted symbol, as Apple Health colours its
/// categories (US-25 AC17d, Brad 2026-10-22: colour on the sections, not on every
/// reading). The tints match the charts' (MetricChart.colors).
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

/// A value's recent days as a small line (US-25 AC17d), the web's Trend sparkline
/// (BloodTestTimeline.tsx). Nothing for fewer than two days.
struct Sparkline: View {
    let points: [Double]
    let tint: Color
    /// A row's line is small; a vitals card draws it larger.
    var size = CGSize(width: 44, height: 18)

    var body: some View {
        if points.count >= 2 {
            Canvas { context, size in
                let low = points.min()!, high = points.max()!
                let span = high - low == 0 ? 1 : high - low
                let pad = 2.0
                let spot = { (index: Int) in
                    CGPoint(x: pad + Double(index) / Double(self.points.count - 1) * (size.width - pad * 2),
                            y: size.height - pad - (self.points[index] - low) / span * (size.height - pad * 2))
                }
                var line = Path()
                line.move(to: spot(0))
                for index in points.indices.dropFirst() { line.addLine(to: spot(index)) }
                var area = line
                area.addLine(to: CGPoint(x: size.width - pad, y: size.height))
                area.addLine(to: CGPoint(x: pad, y: size.height))
                area.closeSubpath()
                context.fill(area, with: .linearGradient(Gradient(colors: [tint.opacity(0.25), tint.opacity(0)]),
                                                         startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)))
                context.stroke(line, with: .color(tint), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                let last = spot(points.count - 1)
                context.fill(Path(ellipseIn: CGRect(x: last.x - 2, y: last.y - 2, width: 4, height: 4)), with: .color(tint))
            }
            .frame(width: size.width, height: size.height)
            .accessibilityHidden(true)
        }
    }
}
