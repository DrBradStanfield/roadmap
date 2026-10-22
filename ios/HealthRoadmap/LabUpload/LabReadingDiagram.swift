import SwiftUI

/// What happens while a lab report is read (US-52 AC12, Brad 2026-10-22), shown in
/// place of a spinner: the report goes through Dr Brad's server to Claude, which
/// reads it, and the values come back to this iPhone for the person to check. The
/// report itself is not kept. Silver beads carry the report in, green beads carry
/// values out. Still under Reduce Motion.
struct LabReadingDiagram: View {
    /// The step in words ("Reading the values"), under the picture.
    let step: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 14) {
            GeometryReader { geometry in
                let y = geometry.size.height / 2 - 12
                let report = CGPoint(x: geometry.size.width * 0.16, y: y)
                let reader = CGPoint(x: geometry.size.width * 0.5, y: y)
                let record = CGPoint(x: geometry.size.width * 0.84, y: y)
                ZStack {
                    TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { timeline in
                        Canvas { context, _ in
                            let time = reduceMotion ? 0.3 : timeline.date.timeIntervalSinceReferenceDate
                            beads(from: report, to: reader, colors: Self.silver, at: time, in: &context)
                            beads(from: reader, to: record, colors: Self.green, at: time + 0.6, in: &context)
                        }
                    }
                    node("doc.text.fill", label: "Your report").position(report)
                    node("sparkles", label: "Read by AI", tint: .accentColor)
                        .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion)
                        .position(reader)
                    node("heart.text.square.fill", label: "Your record", tint: .red).position(record)
                }
            }
            .frame(height: 120)
            .dynamicTypeSize(...DynamicTypeSize.accessibility2)
            Text(step).font(.headline)
            Text("Your report goes through Dr Brad's server to Claude, which reads the values. The report is not kept, and you check every value before it is saved.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
        .accessibilityElement(children: .combine)
    }

    private static let silver = Gradient(colors: [.white, Color(white: 0.82), Color(white: 0.55)])
    private static let green = Gradient(colors: [Color(red: 0.6, green: 0.95, blue: 0.75), .accentColor])

    /// Three beads running one way along a gentle arc, fading in and out at the icons.
    private func beads(from start: CGPoint, to end: CGPoint, colors: Gradient, at time: Double, in context: inout GraphicsContext) {
        let startEdge = CGPoint(x: start.x + 34, y: start.y), endEdge = CGPoint(x: end.x - 34, y: end.y)
        let control = CGPoint(x: (startEdge.x + endEdge.x) / 2, y: start.y - 26)
        var line = Path()
        line.move(to: startEdge)
        line.addQuadCurve(to: endEdge, control: control)
        context.stroke(line, with: .color(.secondary.opacity(0.25)), style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [3, 5]))
        for offset in [0.0, 0.33, 0.66] {
            let t = (time / 1.8 + offset).truncatingRemainder(dividingBy: 1)
            let u = 1 - t
            let point = CGPoint(x: u * u * startEdge.x + 2 * u * t * control.x + t * t * endEdge.x,
                                y: u * u * startEdge.y + 2 * u * t * control.y + t * t * endEdge.y)
            let radius = 4.5
            let dot = Path(ellipseIn: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2))
            var bead = context
            bead.opacity = min(1, min(t, 1 - t) * 6)
            bead.addFilter(.shadow(color: .black.opacity(0.3), radius: 2, y: 1))
            bead.fill(dot, with: .radialGradient(colors, center: CGPoint(x: point.x - radius / 3, y: point.y - radius / 3),
                                                 startRadius: 0, endRadius: radius * 1.4))
        }
    }

    private func node(_ symbol: String, label: String, tint: Color = .primary) -> some View {
        VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 28))
                .foregroundStyle(tint)
                .frame(width: 56, height: 56)
                .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 14, style: .continuous))
            Text(label).font(.caption).foregroundStyle(.secondary).lineLimit(1).fixedSize()
        }
        .accessibilityHidden(true)
    }
}

#Preview {
    LabReadingDiagram(step: "Reading the values")
}
