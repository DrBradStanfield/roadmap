import SwiftUI

/// The app's mark: a white road with green lane dashes winding up from the bottom edge to a
/// red heart with a white outline, on a green gradient. Our own drawing, the original icon
/// ported from the deleted `make-icon.py` (Brad 2026-10-25). No SF Symbols, traced or not:
/// Apple's licence forbids them in app icons and logos (US-25 AC10). The welcome screen shows
/// it in a circle, the road running off the circle's bottom edge; `ios/scripts/make-icon.swift`
/// compiles this file and renders it full-bleed as the app icon, so the two never drift.
///
/// Coordinates are in a 100 × 100 design square (the welcome circle's points).
struct LogoMark: View {
    /// The app icon: a square filled to the edge.
    var fullBleed = false
    /// Changing it bounces the heart once (callers gate it on Reduce Motion).
    var bounce = false

    static let gradient = LinearGradient(
        colors: [Color(red: 0.2, green: 0.83, blue: 0.47), Color(red: 0.03, green: 0.47, blue: 0.43)],
        startPoint: .topLeading, endPoint: .bottomTrailing)
    static let heartRed = Color(red: 1, green: 0.27, blue: 0.35)
    static let dashGreen = Color(red: 0.13, green: 0.67, blue: 0.45)
    static let shadow = Color(red: 0, green: 0.24, blue: 0.2)

    var body: some View {
        ZStack {
            if fullBleed {
                Rectangle().fill(Self.gradient)
            } else {
                Circle().fill(Self.gradient).shadow(color: .green.opacity(0.3), radius: 20, y: 10)
            }
            ZStack {
                LogoRoad().fill(Self.shadow.opacity(0.45)).blur(radius: 2).offset(y: 1.2)
                LogoRoad().fill(.white)
                LogoRoad(drawn: LogoRoad.dashes).fill(Self.dashGreen)
                ZStack {
                    LogoHeart(drawn: LogoHeart.shadow).fill(Self.shadow).blur(radius: 2)
                    LogoHeart().fill(.white)
                    LogoHeart(drawn: LogoHeart.red).fill(Self.heartRed)
                }
                .keyframeAnimator(initialValue: 1.0, trigger: bounce) { heart, scale in
                    heart.scaleEffect(scale, anchor: LogoHeart.centre)
                } keyframes: { _ in
                    SpringKeyframe(1.25, duration: 0.15)
                    SpringKeyframe(1, duration: 0.35)
                }
            }
            .frame(width: 100, height: 100)
            .clipShape(fullBleed ? AnyShape(Rectangle()) : AnyShape(Circle()))
        }
        .frame(width: 100, height: 100)
    }
}

/// A path drawn in the 100 × 100 design square, scaled onto `rect`.
private func fitted(_ path: Path, to rect: CGRect) -> Path {
    path.applying(CGAffineTransform(a: rect.width / 100, b: 0, c: 0, d: rect.height / 100, tx: rect.minX, ty: rect.minY))
}

/// The road: one cubic curve from below the bottom edge up toward the heart, swept by a
/// circle that shrinks from `r0` to `r1`, so it narrows with distance. The lane dashes are
/// short spans of the same curve with a thin circle. Each is built once.
struct LogoRoad: Shape {
    static let road = sweep([0...1], r0: 15, r1: 2.8)
    /// Five dashes and a gap at a time, stopping short of the heart.
    static let dashes = sweep((0..<5).map { CGFloat(2 * $0) / 11...CGFloat(2 * $0 + 1) / 11 } + [(10 / 11)...0.93], r0: 1.2, r1: 0.4)
    var drawn = road

    func path(in rect: CGRect) -> Path { fitted(drawn, to: rect) }

    /// The stretches `spans` of the curve, swept by the shrinking circle.
    private static func sweep(_ spans: [ClosedRange<CGFloat>], r0: CGFloat, r1: CGFloat) -> Path {
        let c: [CGPoint] = [CGPoint(x: 38, y: 105), CGPoint(x: 95, y: 78), CGPoint(x: 8, y: 52), CGPoint(x: 60, y: 39)]
        func point(_ t: CGFloat) -> CGPoint {
            let u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t
            return CGPoint(x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x,
                           y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y)
        }
        func tangent(_ t: CGFloat) -> CGVector {
            let u = 1 - t, a = 3 * u * u, b = 6 * u * t, d = 3 * t * t
            return CGVector(dx: a * (c[1].x - c[0].x) + b * (c[2].x - c[1].x) + d * (c[3].x - c[2].x),
                            dy: a * (c[1].y - c[0].y) + b * (c[2].y - c[1].y) + d * (c[3].y - c[2].y))
        }
        let dr = r1 - r0
        var road = Path()
        for span in spans {
            // The swept circles' envelope: where each circle touches the next one.
            var left: [CGPoint] = [], right: [CGPoint] = []
            let steps = max(4, Int((span.upperBound - span.lowerBound) * 200))
            for i in 0...steps {
                let t = span.lowerBound + (span.upperBound - span.lowerBound) * CGFloat(i) / CGFloat(steps)
                let o = point(t), v = tangent(t), r = r0 + (r1 - r0) * t
                let len2 = v.dx * v.dx + v.dy * v.dy
                let along = -dr / len2, across = (len2 - dr * dr).squareRoot() / len2
                left.append(CGPoint(x: o.x + r * (along * v.dx - across * v.dy), y: o.y + r * (along * v.dy + across * v.dx)))
                right.append(CGPoint(x: o.x + r * (along * v.dx + across * v.dy), y: o.y + r * (along * v.dy - across * v.dx)))
            }
            var piece = Path()
            piece.addLines(left + right.reversed())
            piece.closeSubpath()
            // Round ends: the first and last circles.
            for t in [span.lowerBound, span.upperBound] {
                let o = point(t), r = r0 + (r1 - r0) * t
                piece = piece.union(Path(ellipseIn: CGRect(x: o.x - r, y: o.y - r, width: 2 * r, height: 2 * r)))
            }
            road.addPath(piece)
        }
        return road
    }
}

/// The classic heart curve: its white outline, and the shadow and red heart drawn with it.
/// Each is built once.
struct LogoHeart: Shape {
    static let centre = UnitPoint(x: 0.6, y: 0.24)
    static let outline = heart(y: 22, width: 30)
    static let shadow = heart(y: 23.5, width: 30)
    static let red = heart(y: 22.4, width: 21.6)
    var drawn = outline

    func path(in rect: CGRect) -> Path { fitted(drawn, to: rect) }

    /// The heart `width` wide, centred at (60, `y`).
    private static func heart(y: CGFloat, width: CGFloat) -> Path {
        let w = width / 32
        var path = Path()
        path.addLines((0..<240).map { i in
            let a = 2 * CGFloat.pi * CGFloat(i) / 240
            let hx = 16 * pow(sin(a), 3)
            let hy = 13 * cos(a) - 5 * cos(2 * a) - 2 * cos(3 * a) - cos(4 * a)
            return CGPoint(x: 60 + hx * w, y: y - hy * w)
        })
        path.closeSubpath()
        return path
    }
}
