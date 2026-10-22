import SwiftUI

/// What "Add medical records" does, drawn before anything is picked (US-52 AC13b, Brad
/// 2026-10-22), as the sync diagram explains sync before Connect: a lab report and a
/// clinic letter are read, their results lift off the page and land in the person's
/// record, each with a tick for the check before it is saved. Still under Reduce Motion.
struct LabUploadExplainer: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// One loop, in seconds: the scan, then three results flying in turn.
    private static let loop = 6.0
    /// The results shown flying: names only, never a value.
    private static let results = ["LDL", "HbA1c", "ApoB"]

    var body: some View {
        VStack(spacing: 12) {
            TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { timeline in
                let t = reduceMotion ? 0.62 : (timeline.date.timeIntervalSinceReferenceDate / Self.loop).truncatingRemainder(dividingBy: 1)
                GeometryReader { geometry in
                    let papers = CGPoint(x: geometry.size.width * 0.2, y: geometry.size.height / 2)
                    let record = CGPoint(x: geometry.size.width * 0.8, y: geometry.size.height / 2)
                    ZStack {
                        pages(scan: t).position(papers)
                        ForEach(Array(Self.results.enumerated()), id: \.offset) { index, name in
                            chip(name, at: t, start: 0.3 + Double(index) * 0.15, from: papers, to: record)
                        }
                        recordCard(filled: Self.landed(at: t)).position(record)
                    }
                }
            }
            .frame(height: 130)
            // The drawing's boxes are fixed; past this its labels outgrow them (review R6). The sentence below grows freely.
            .dynamicTypeSize(...DynamicTypeSize.xxLarge)
            .accessibilityHidden(true)
            Text("Point the app at your medical records: a folder, a ZIP, or one PDF or photo. It reads the test results in your lab reports and clinic letters. You check each one before it's saved.\n\nClaude reads them through Dr Brad's server, which keeps no copy. Your originals stay in your own cloud.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    /// How many results have landed by `t`: each flight takes 0.25 of the loop.
    private static func landed(at t: Double) -> Int {
        results.indices.filter { t >= 0.3 + Double($0) * 0.15 + 0.25 }.count
    }

    // MARK: Pieces

    /// A lab report with a clinic letter tucked behind it, and a light sweeping down them.
    private func pages(scan t: Double) -> some View {
        ZStack {
            page(symbol: "envelope.open.fill", title: "Letter").rotationEffect(.degrees(-12)).offset(x: -26, y: 6)
            page(symbol: "doc.text.fill", title: "Lab report").rotationEffect(.degrees(6)).offset(x: 18)
                .overlay {
                    // The scan: down the page in the loop's first 30%, then gone.
                    let sweep = min(t / 0.3, 1)
                    LinearGradient(colors: [.clear, Color.accentColor.opacity(0.45), .clear], startPoint: .top, endPoint: .bottom)
                        .frame(height: 14)
                        .offset(y: -40 + sweep * 80)
                        .opacity(t < 0.3 ? 1 : 0)
                        .offset(x: 18)
                }
        }
    }

    private func page(symbol: String, title: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: symbol).font(.title3).foregroundStyle(.secondary)
            ForEach(0..<3, id: \.self) { line in
                Capsule().fill(Color.secondary.opacity(0.25)).frame(width: line == 2 ? 26 : 40, height: 4)
            }
            Text(title).font(.caption2).foregroundStyle(.secondary).lineLimit(1).fixedSize()
        }
        .frame(width: 66, height: 90)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 10, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 4, y: 2)
    }

    /// One result lifting off the page and arcing into the record, fading at both ends.
    private func chip(_ name: String, at t: Double, start: Double, from: CGPoint, to: CGPoint) -> some View {
        let p = min(max((t - start) / 0.25, 0), 1)
        let eased = p * p * (3 - 2 * p)
        let control = CGPoint(x: (from.x + to.x) / 2, y: min(from.y, to.y) - 50)
        let u = 1 - eased
        let point = CGPoint(x: u * u * from.x + 2 * u * eased * control.x + eased * eased * to.x,
                            y: u * u * from.y + 2 * u * eased * control.y + eased * eased * to.y)
        return HStack(spacing: 4) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor)
            Text(name).font(.caption.weight(.semibold))
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(.background, in: Capsule())
        .shadow(color: .black.opacity(0.15), radius: 3, y: 1)
        .scaleEffect(0.8 + 0.2 * sin(eased * .pi))
        .opacity(p <= 0 || p >= 1 ? 0 : min(1, min(p, 1 - p) * 8))
        .position(point)
    }

    /// The person's record, a tick per result that has landed.
    private func recordCard(filled: Int) -> some View {
        VStack(spacing: 6) {
            Image(systemName: "heart.text.square.fill").font(.system(size: 30)).foregroundStyle(.red)
            HStack(spacing: 3) {
                ForEach(Self.results.indices, id: \.self) { index in
                    Image(systemName: index < filled ? "checkmark.circle.fill" : "circle")
                        .font(.caption2)
                        .foregroundStyle(index < filled ? Color.accentColor : Color.secondary.opacity(0.5))
                        .contentTransition(.symbolEffect(.replace))
                }
            }
            Text("Your record").font(.caption2).foregroundStyle(.secondary).lineLimit(1).fixedSize()
        }
        .frame(width: 80, height: 90)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 14, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 4, y: 2)
        .animation(reduceMotion ? nil : .bouncy, value: filled)
    }
}

#Preview {
    List { Section { LabUploadExplainer() } }
}
