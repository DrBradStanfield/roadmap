import SwiftUI

/// How My data draws one value (US-25 AC17, AC17d): a row, or an Apple Health card for
/// a vital, with its trend line and a bounce when a new value lands. `CardValue` is
/// shared with the plan's summary tiles, `LabelValue` with the metric page. The web
/// twins are the value cells of StartingInfoVitals.tsx and BloodTestTimeline.tsx.

/// One row: the label, then the value and its unit, or "Add" when there is none.
struct ValueRow: View {
    let label: String
    let value: String?
    let unit: String
    /// YYYY-MM-DD, shown under the label.
    let day: String?
    /// A US height, shown as 5 ft 10 in in place of the value (AC17).
    var feetInches: MyData.FeetInches?
    /// The recent days, drawn small beside the value (AC17d).
    var trend: [Double] = []
    var tint: Color = .blue
    /// Drawn as an Apple Health card: the plain name and day on top, the value large
    /// below with a larger trend in the metric's colour beside it.
    var card = false
    /// The section's widest reading: it sets this row's value column, so values and
    /// trends line up down the section however wide one value is (Brad 2026-10-23).
    var column: Column?
    @Environment(\.dynamicTypeSize) private var textSize
    /// A compact row's trend, growing a little with the text.
    @ScaledMetric(relativeTo: .body) private var trendWidth = 44.0
    /// Counts the value's own changes: a new value in the same unit, not a units switch (review R3).
    @State private var bounces = 0
    @State private var shownUnit: String?

    var body: some View {
        Group {
            if card, let value { cardBody(value) } else { rowBody }
        }
        .animation(.snappy, value: value)
        .onChange(of: value) {
            if shownUnit == nil || shownUnit == unit { bounces += 1 }
            shownUnit = unit
        }
        .onAppear { shownUnit = unit }
        .contentShape(Rectangle())
    }

    /// The card's day as Apple Health's cards write it: Today, Yesterday, then the date (AC17).
    private func cardBody(_ value: String) -> some View {
        CardShell(label: label, when: day.map { DayText.when(day: $0, now: .now, calendar: .autoupdatingCurrent) }, trend: trend, tint: tint) {
            CardValue(value: value, unit: unit, bounces: bounces)
        }
    }

    private var rowBody: some View {
        // Side by side: the trend, then the value over its unit, right-aligned in the section's
        // column. At accessibility sizes, under the label and inline.
        let stacked = !textSize.isAccessibilitySize
        return LabelValue.layout(textSize).callAsFunction {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                if let day {
                    Text(DayText.short(day)).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            HStack(alignment: stacked ? .center : .firstTextBaseline, spacing: 12) {
                Sparkline(points: trend, tint: tint, size: stacked ? CGSize(width: trendWidth, height: trendWidth * 18 / 44) : CGSize(width: 44, height: 18))
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
                ZStack(alignment: .trailing) {
                    if stacked, let column {
                        Group {
                            if let value = column.value { reading(value, column.unit, stacked: true) }
                            if let height = column.feetInches { reading(height.text, "", feetInches: height, stacked: true) }
                            if column.add { reading(nil, "", stacked: true) }
                        }
                        .hidden()
                        .accessibilityHidden(true)
                    }
                    reading(value, unit, feetInches: feetInches, stacked: stacked)
                }
            }
        }
    }

    /// A section's widest reading, worked out once for the section (MyDataView) and drawn
    /// hidden in each of its rows.
    struct Column {
        /// Zeros as long as the longest value: in monospaced digits no digit is wider.
        let value: String?
        /// The longest unit shown with a value.
        let unit: String
        /// Some row has no value, so says "Add".
        let add: Bool
        /// The longest US height by its displayed text ("5 ft 10 in"), drawn as it shows:
        /// its raw value and unit are not what the row draws.
        let feetInches: MyData.FeetInches?

        init(_ readings: [(value: String?, unit: String, feetInches: MyData.FeetInches?)]) {
            let shown = readings.filter { $0.value != nil }
            let plain = shown.filter { $0.feetInches == nil }
            value = plain.compactMap(\.value).map(\.count).max().map { String(repeating: "0", count: $0) }
            unit = plain.map(\.unit).max { $0.count < $1.count } ?? ""
            feetInches = shown.compactMap(\.feetInches).max { $0.text.count < $1.text.count }
            add = readings.contains { $0.value == nil }
        }
    }

    /// A value and its unit: the unit under it in a compact row, beside it otherwise; a US
    /// height as feet and inches side by side; "Add" when there is none.
    @ViewBuilder
    private func reading(_ value: String?, _ unit: String, feetInches: MyData.FeetInches? = nil, stacked: Bool) -> some View {
        if let value {
            let parts = feetInches.map { [(String($0.feet), "ft"), (String($0.inches), "in")] } ?? [(value, unit)]
            let under = stacked && feetInches == nil
            let pair = under ? AnyLayout(VStackLayout(alignment: .trailing, spacing: 0)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 4))
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                ForEach(parts.indices, id: \.self) { index in
                    pair {
                        Text(parts[index].0)
                            .font(.body.weight(.semibold))
                            .monospacedDigit()
                            .contentTransition(.numericText())
                            .modifier(Bounce(trigger: bounces, anchor: .trailing))
                        Text(parts[index].1).font(under ? .caption : .subheadline).foregroundStyle(.secondary)
                    }
                }
            }
        } else {
            // VoiceOver: "LDL Cholesterol, no value yet, add one", never a bare "Add" beside the lab upload's (US-52 AC7b).
            Text("Add").foregroundStyle(Color.accentColor).accessibilityLabel("No value yet, add one")
        }
    }
}

/// An Apple Health card (AC17), shared by a vital's card and US-56's live cards: the plain
/// name, its day or time and a chevron on top; the value large with a larger trend in the
/// metric's colour beside it. VoiceOver reads it as one element, chevron left out. Name
/// over day at accessibility sizes, where one line would squeeze, and no trend.
struct CardShell<Value: View>: View {
    let label: String
    let when: String?
    let trend: [Double]
    let tint: Color
    @ViewBuilder let value: Value
    @Environment(\.dynamicTypeSize) private var textSize

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            LabelValue.layout(textSize).callAsFunction {
                Text(label).font(.subheadline.weight(.semibold))
                Spacer()
                HStack {
                    if let when { Text(when).font(.footnote).foregroundStyle(.secondary) }
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
            }
            HStack(alignment: .bottom) {
                value
                Spacer(minLength: 12)
                if !textSize.isAccessibilitySize {
                    Sparkline(points: trend, tint: tint, size: CGSize(width: 110, height: 40))
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

/// A card's value, large, with its unit: My data's vitals cards and the plan's summary tiles.
struct CardValue: View {
    let value: String
    /// Empty for a value with no unit (BMI).
    let unit: String
    /// Counts new values, for My data's bounce.
    var bounces = 0

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(value)
                .font(.system(.title, design: .rounded).weight(.semibold))
                .monospacedDigit()
                .contentTransition(.numericText())
                .modifier(Bounce(trigger: bounces, anchor: .leading))
            if !unit.isEmpty {
                Text(unit).font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
            }
        }
    }
}

/// A small spring when a new value arrives, saved here or synced in (AC17d); not on a
/// units switch. Still under Reduce Motion.
private struct Bounce: ViewModifier {
    let trigger: Int
    let anchor: UnitPoint
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        // Read here: the animator's closure is Sendable and may not touch the environment.
        let (still, anchor) = (reduceMotion, anchor)
        return content.keyframeAnimator(initialValue: 1.0, trigger: trigger) { content, scale in
            content.scaleEffect(still ? 1 : scale, anchor: anchor)
        } keyframes: { _ in
            SpringKeyframe(1.15, duration: 0.15, spring: .snappy)
            SpringKeyframe(1.0, spring: .bouncy)
        }
    }
}

/// A row's label and value: side by side, stacked at accessibility text sizes so
/// neither is squeezed into a broken word. Used by My data and the metric page.
enum LabelValue {
    /// Side by side, the value centred on the row (Brad 2026-10-23): on the label's first
    /// line, a value whose label has a day or a note under it sat high.
    static func layout(_ size: DynamicTypeSize) -> AnyLayout {
        size.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(alignment: .center))
    }
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
