import SwiftUI

/// The app's mark: a white S-shaped road and a red heart on a green gradient.
/// Drawn here, not with SF Symbols: Apple's SF Symbols licence forbids them in
/// app icons and logos (US-25 AC10). The welcome screen shows it in a circle;
/// `ios/scripts/make-icon.swift` compiles this file and renders it full-bleed
/// as the app icon, so the two never drift.
///
/// Coordinates are in a 100 × 100 design square (the welcome circle's points).
struct LogoMark: View {
    /// The app icon: a square filled to the edge, marks a little larger.
    var fullBleed = false
    /// Changing it bounces the heart once (callers gate it on Reduce Motion).
    var bounce = false

    static let gradient = LinearGradient(
        colors: [Color(red: 0.2, green: 0.83, blue: 0.47), Color(red: 0.03, green: 0.47, blue: 0.43)],
        startPoint: .topLeading, endPoint: .bottomTrailing)
    static let heartRed = Color(red: 1, green: 0.27, blue: 0.35)

    var body: some View {
        ZStack {
            if fullBleed {
                Rectangle().fill(Self.gradient)
            } else {
                Circle().fill(Self.gradient).shadow(color: .green.opacity(0.3), radius: 20, y: 10)
            }
            ZStack {
                LogoRoad().stroke(.white, style: StrokeStyle(lineWidth: 4.65, lineCap: .round, lineJoin: .round))
                LogoRoadEnds().fill(.white)
                LogoHeart().fill(Self.heartRed)
                    .keyframeAnimator(initialValue: 1.0, trigger: bounce) { heart, scale in
                        heart.scaleEffect(scale, anchor: LogoHeart.centre)
                    } keyframes: { _ in
                        SpringKeyframe(1.25, duration: 0.15)
                        SpringKeyframe(1, duration: 0.35)
                    }
            }
            .frame(width: 100, height: 100)
            .scaleEffect(fullBleed ? 1.04 : 1)
        }
        .frame(width: 100, height: 100)
    }
}

/// Maps the 100 × 100 design square onto `rect`.
private func design(_ rect: CGRect) -> (CGFloat, CGFloat) -> CGPoint {
    { x, y in CGPoint(x: rect.minX + x * rect.width / 100, y: rect.minY + y * rect.height / 100) }
}

/// The road's centre line, from the top-right end to the bottom-left end.
struct LogoRoad: Shape {
    func path(in rect: CGRect) -> Path {
        let p = design(rect)
        var path = Path()
        path.move(to: p(56.9, 40.3))
        path.addLine(to: p(37.5, 40.3))
        path.addCurve(to: p(27.9, 48.0), control1: p(31.0, 40.3), control2: p(27.9, 43.8))
        path.addCurve(to: p(40.4, 56.5), control1: p(27.9, 53.5), control2: p(33.0, 56.1))
        path.addLine(to: p(50.9, 57.6))
        path.addCurve(to: p(61.9, 65.6), control1: p(57.4, 58.3), control2: p(61.9, 60.9))
        path.addCurve(to: p(53.3, 73.5), control1: p(61.9, 70.9), control2: p(58.0, 73.5))
        path.addLine(to: p(32.8, 73.5))
        return path
    }
}

/// The two round ends of the road.
struct LogoRoadEnds: Shape {
    func path(in rect: CGRect) -> Path {
        let p = design(rect), r = 7.15 * rect.width / 100
        var path = Path()
        for c in [p(56.9, 40.3), p(32.8, 73.5)] {
            path.addEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
        }
        return path
    }
}

/// Two round lobes curving down to a rounded tip.
struct LogoHeart: Shape {
    static let centre = UnitPoint(x: 0.72, y: 0.28)

    func path(in rect: CGRect) -> Path {
        let p = design(rect), k = rect.width / 100
        let r = 6.45 * k, half = 4.22 * k, mid = p(71.97, 24.57), tip = p(71.97, 37.7)
        let left = CGPoint(x: mid.x - half, y: mid.y), right = CGPoint(x: mid.x + half, y: mid.y)
        // Where the lobes meet at the top: the circles' upper crossing.
        let notch = Angle(radians: acos(half / r))
        let drop = 6 * k, round = 2 * k
        var path = Path()
        path.move(to: CGPoint(x: left.x - r, y: left.y))
        path.addArc(center: left, radius: r, startAngle: .degrees(180), endAngle: .degrees(360) - notch, clockwise: false)
        path.addArc(center: right, radius: r, startAngle: .degrees(180) + notch, endAngle: .degrees(360), clockwise: false)
        path.addCurve(to: tip, control1: CGPoint(x: right.x + r, y: mid.y + drop), control2: CGPoint(x: tip.x + round, y: tip.y))
        path.addCurve(to: CGPoint(x: left.x - r, y: left.y), control1: CGPoint(x: tip.x - round, y: tip.y),
                      control2: CGPoint(x: left.x - r, y: mid.y + drop))
        path.closeSubpath()
        return path
    }
}
