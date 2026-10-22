import SwiftUI

/// How sync works, drawn (US-25 AC11h, Brad 2026-10-22): the person's own cloud at
/// the top, this iPhone and the website below it, and silver data flowing both ways
/// along each line. No line reaches Dr Brad's server, because none does. Still
/// under Reduce Motion.
struct SyncDiagram: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geometry in
            let layout = Layout(size: geometry.size)
            ZStack {
                TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { timeline in
                    Canvas { context, _ in
                        let time = reduceMotion ? 0.35 : timeline.date.timeIntervalSinceReferenceDate
                        for line in [layout.phoneLine, layout.laptopLine] {
                            context.stroke(line.path, with: .color(.secondary.opacity(0.25)),
                                           style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [3, 5]))
                            for particle in Self.particles {
                                draw(particle, on: line, at: time, in: &context)
                            }
                        }
                    }
                }
                node("iphone", label: "This iPhone").position(layout.phone)
                node("laptopcomputer", label: "The website").position(layout.laptop)
                node("cloud.fill", label: "Your cloud", tint: .accentColor).position(layout.cloud)
            }
        }
        .frame(height: 190)
        // Past this the labels outgrow the fixed layout (re-check R8); the sentence below says it all.
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Your record moves between this iPhone and your Dropbox or Google Drive, and between there and the website. Dr Brad's server is not part of it.")
    }

    // MARK: Drawing

    /// One silver dot: which way it travels (up from the device, or down to it), its
    /// head start and its speed, so the two directions interleave without colliding.
    private struct Particle { let up: Bool; let offset: Double; let period: Double }

    private static let particles: [Particle] = [
        Particle(up: true, offset: 0, period: 2.4), Particle(up: true, offset: 0.5, period: 2.4),
        Particle(up: false, offset: 0.25, period: 2.4), Particle(up: false, offset: 0.75, period: 2.4),
    ]

    private func draw(_ particle: Particle, on line: Line, at time: Double, in context: inout GraphicsContext) {
        let phase = (time / particle.period + particle.offset).truncatingRemainder(dividingBy: 1)
        let point = line.point(at: particle.up ? phase : 1 - phase)
        // Fades in and out at the ends, so a dot never pops into being at an icon.
        let fade = min(1, min(phase, 1 - phase) * 6)
        let radius = 4.5
        let dot = Path(ellipseIn: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2))
        var bead = context
        bead.opacity = fade
        // A soft shadow lifts the bead off a white list in light mode; a glow lights it in dark.
        bead.addFilter(.shadow(color: .black.opacity(0.3), radius: 2, y: 1))
        bead.fill(dot, with: .radialGradient(Self.silver, center: CGPoint(x: point.x - radius / 3, y: point.y - radius / 3),
                                             startRadius: 0, endRadius: radius * 1.4))
    }

    private static let silver = Gradient(colors: [.white, Color(white: 0.82), Color(white: 0.55)])

    private func node(_ symbol: String, label: String, tint: Color = .primary) -> some View {
        VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 30, weight: .regular))
                .foregroundStyle(tint)
                .frame(width: 56, height: 56)
                .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 14, style: .continuous))
            Text(label).font(.caption).foregroundStyle(.secondary).lineLimit(1).fixedSize()
        }
    }

    // MARK: Geometry

    /// A curve from a device up to the cloud: a quadratic Bézier bowed outwards.
    private struct Line {
        let start: CGPoint, control: CGPoint, end: CGPoint

        var path: Path {
            Path { path in
                path.move(to: start)
                path.addQuadCurve(to: end, control: control)
            }
        }

        /// The point at `t` (0 at the device, 1 at the cloud).
        func point(at t: Double) -> CGPoint {
            let u = 1 - t
            return CGPoint(x: u * u * start.x + 2 * u * t * control.x + t * t * end.x,
                           y: u * u * start.y + 2 * u * t * control.y + t * t * end.y)
        }
    }

    private struct Layout {
        let cloud: CGPoint, phone: CGPoint, laptop: CGPoint

        init(size: CGSize) {
            cloud = CGPoint(x: size.width / 2, y: 40)
            phone = CGPoint(x: size.width * 0.18, y: size.height - 44)
            laptop = CGPoint(x: size.width * 0.82, y: size.height - 44)
        }

        /// Lines run between the icons' edges, not their centres.
        var phoneLine: Line { line(from: phone, bow: -1) }
        var laptopLine: Line { line(from: laptop, bow: 1) }

        private func line(from device: CGPoint, bow: CGFloat) -> Line {
            let start = CGPoint(x: device.x, y: device.y - 34)
            let end = CGPoint(x: cloud.x + 34 * bow, y: cloud.y + 8)
            let control = CGPoint(x: device.x, y: cloud.y + 8)
            return Line(start: start, control: control, end: end)
        }
    }
}

#Preview {
    List { Section { SyncDiagram() } }
}
