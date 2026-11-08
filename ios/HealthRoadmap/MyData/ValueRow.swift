import SwiftUI

/// How My data draws one value (US-25 AC17, AC17d): a row, or an Apple Health card for
/// a vital, with its trend line and a bounce when a new value lands. `CardValue` is
/// shared with the plan's summary tiles, `LabelValue` with the metric page. The web
/// twin of the row is MyDataRows.tsx's MetricRow (US-62 AC8).

/// One row, as the web's phone rows (MyDataRows.tsx, US-62 AC8): the label with "target · date"
/// under it, the trend, then the value with the previous one in brackets over its unit, or "Add".
struct ValueRow: View {
    let label: String
    let value: String?
    let unit: String
    /// YYYY-MM-DD, shown under the label as "Oct 2026".
    let day: String?
    /// The engine's target line ("Optimal <1.4"), shown under the label before the date.
    var target: String?
    /// The value before this one, in the same units, shown after it in brackets: "81 (74)".
    var previous: String?
    /// The engine's grade: an off-target value is drawn in its colour, as the web's row (US-62 AC8).
    var grade: MyData.Grade?
    /// The grade as VoiceOver says it after the value, off target only ("above optimal").
    var gradeWords: String?
    /// Why a value printed as a limit has no grade, said in the grade's place, as the web's row says it.
    var note: String?
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
    @ScaledMetric(relativeTo: .body) private var trendWidth = 56.0
    /// The label block's height and its first and last baselines, from its top: the trend's box
    /// and the ink band it is drawn over (US-62 AC8a).
    @State private var name = NameBox()
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
            CardValue(value: value, unit: unit, bounces: bounces, color: Self.gradeColor(grade), spoken: spokenLabel(value, previous: nil))
        }
    }

    private var rowBody: some View {
        // Side by side: the trend, then the value over its unit, right-aligned in the section's
        // column. At accessibility sizes, under the label and inline.
        let stacked = !textSize.isAccessibilitySize
        return LabelValue.layout(textSize).callAsFunction {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                let meta = [target, day.map(DayText.monthYear)].compactMap { $0 }
                if !meta.isEmpty {
                    // One line when it fits; else the target over the date, so "Oct 2026" never
                    // breaks in two (a 375-pt phone at large text, no sex: "Normal 60–110/45–90").
                    ViewThatFits(in: .horizontal) {
                        Text(meta.joined(separator: " · "))
                        VStack(alignment: .leading, spacing: 0) { ForEach(meta, id: \.self) { Text($0) } }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
            }
            .background(alignment: Alignment(horizontal: .leading, vertical: .firstTextBaseline)) { Self.mark { name.firstBaseline = $0 } }
            .background(alignment: Alignment(horizontal: .leading, vertical: .lastTextBaseline)) { Self.mark { name.lastBaseline = $0 } }
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { name.height = $0 }
            .coordinateSpace(.named(NameBox.space))
            Spacer(minLength: 0)
            HStack(alignment: stacked ? .center : .firstTextBaseline, spacing: 12) {
                Sparkline(points: trend, tint: tint, size: Self.trendSize(width: trendWidth, nameHeight: name.height > 0 ? name.height : nil, textSize: textSize),
                          band: stacked ? Self.trendBand(capTop: name.firstBaseline - Self.capHeight(textSize), baseline: name.lastBaseline, width: trendWidth) : nil)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
                ZStack(alignment: .trailing) {
                    if stacked, let column {
                        Group {
                            if let value = column.value { reading(value, column.unit, previous: column.previous, stacked: true) }
                            if let height = column.feetInches { reading(height.text, "", feetInches: height, stacked: true) }
                            if column.add { reading(nil, "", stacked: true) }
                        }
                        .hidden()
                        .accessibilityHidden(true)
                    }
                    reading(value, unit, previous: previous, feetInches: feetInches, stacked: stacked)
                }
            }
        }
    }

    /// A section's widest reading, worked out once for the section (MyDataView) and drawn
    /// hidden in each of its rows.
    struct Column {
        /// Zeros as long as the longest value: in monospaced digits no digit is wider.
        let value: String?
        /// Zeros as long as the longest previous value, drawn in brackets after `value`.
        let previous: String?
        /// The longest unit shown with a value.
        let unit: String
        /// Some row has no value, so says "Add".
        let add: Bool
        /// The longest US height by its displayed text ("5 ft 10 in"), drawn as it shows:
        /// its raw value and unit are not what the row draws.
        let feetInches: MyData.FeetInches?

        init(_ readings: [(value: String?, previous: String?, unit: String, feetInches: MyData.FeetInches?)]) {
            let shown = readings.filter { $0.value != nil }
            let plain = shown.filter { $0.feetInches == nil }
            let zeros = { (texts: [String]) in texts.map(\.count).max().map { String(repeating: "0", count: $0) } }
            value = zeros(plain.compactMap(\.value))
            previous = zeros(plain.compactMap(\.previous))
            unit = plain.map(\.unit).max { $0.count < $1.count } ?? ""
            feetInches = shown.compactMap(\.feetInches).max { $0.text.count < $1.text.count }
            add = readings.contains { $0.value == nil }
        }
    }

    /// A value and its unit: the unit under it in a compact row, beside it otherwise; the
    /// previous value after it in brackets, smaller and grey; a US height as feet and inches
    /// side by side; "Add" when there is none.
    @ViewBuilder
    private func reading(_ value: String?, _ unit: String, previous: String? = nil, feetInches: MyData.FeetInches? = nil, stacked: Bool) -> some View {
        if let value {
            let parts = feetInches.map { [(String($0.feet), "ft"), (String($0.inches), "in")] } ?? [(value, unit)]
            // The unit under the value, but for a US height; at accessibility sizes too, where
            // beside "92.4 (94.1)" it broke as "k" over "g" (US-73, largest size).
            let under = feetInches == nil
            let pair = under ? AnyLayout(VStackLayout(alignment: stacked ? .trailing : .leading, spacing: 0)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 4))
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                ForEach(parts.indices, id: \.self) { index in
                    pair {
                        HStack(alignment: .firstTextBaseline, spacing: 0) {
                            Text(parts[index].0)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(Self.gradeColor(grade) ?? .primary)
                                .monospacedDigit()
                                .contentTransition(.numericText())
                                .modifier(Bounce(trigger: bounces, anchor: .trailing))
                            if let previous {
                                Text(" (\(previous))").font(.footnote).foregroundStyle(.secondary).monospacedDigit()
                            }
                        }
                        // A reading never breaks: at accessibility sizes "92.4 (94.1)" split as "92." over "4".
                        .fixedSize()
                        // VoiceOver: "3.4, above optimal, previous 2.9"; brackets and colour alone say
                        // nothing out loud (the web's rule).
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(spokenLabel(parts[index].0, previous: previous))
                        Text(parts[index].1).font(stacked ? .caption : .subheadline).foregroundStyle(.secondary)
                    }
                }
            }
            // Beside the label, a reading never wraps ("0.9" over "1" at large text on a 375-pt
            // phone): the label wraps instead. Under it, at accessibility sizes, it has the row.
            .fixedSize(horizontal: stacked, vertical: false)
        } else {
            // VoiceOver: "LDL Cholesterol, no value yet, add one", never a bare "Add" beside the lab upload's (US-52 AC7b).
            Text("Add").foregroundStyle(Color.accentColor).accessibilityLabel("No value yet, add one")
        }
    }
}

extension ValueRow {
    /// A compact row's trend box (US-62 AC8a, Brad 2026-11-09): as tall as the label block beside
    /// it, as the web's row. Before that block is measured, the old 44 by 18 shape. At accessibility
    /// sizes, where the row stacks, it stays small beside the value.
    nonisolated static func trendSize(width: CGFloat, nameHeight: CGFloat?, textSize: DynamicTypeSize) -> CGSize {
        if textSize.isAccessibilitySize { return CGSize(width: 44, height: 18) }
        return CGSize(width: width, height: nameHeight ?? width * 18 / 44)
    }

    /// Where in that box the line is drawn: the title's cap height to the date line's baseline,
    /// capped at 0.8 x the width and centred there, so a title wrapped at large text never draws a
    /// tall spike. None while the two are not yet a band wider than the line's 2 pt padding each
    /// side, as the baselines arrive one at a time: the trend then fills its box. The web's twin is
    /// MyDataRows.tsx `trendBand`.
    nonisolated static func trendBand(capTop: CGFloat, baseline: CGFloat, width: CGFloat) -> ClosedRange<CGFloat>? {
        guard baseline - capTop > 4 else { return nil }
        let height = min(baseline - capTop, 0.8 * width)
        let top = capTop + (baseline - capTop - height) / 2
        return top...top + height
    }

    /// The label's cap height: the body text it is drawn in, at `size`.
    static func capHeight(_ size: DynamicTypeSize) -> CGFloat {
        UIFont.preferredFont(forTextStyle: .body, compatibleWith: UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(size))).capHeight
    }

    /// A zero-size mark that reports its height from the label block's top: set on a baseline, it
    /// reads that baseline.
    static func mark(_ read: @escaping (CGFloat) -> Void) -> some View {
        Color.clear.frame(width: 0, height: 0)
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(NameBox.space)).minY } action: { read($0) }
    }

    /// The label block as laid out: its height, and its first and last baselines from its top.
    struct NameBox: Equatable {
        static let space = "value-row-name"
        var height: CGFloat = 0, firstBaseline: CGFloat = 0, lastBaseline: CGFloat = 0
    }

    /// A grade's colour, the web's row colours (styles.css `.md-status-warn` amber #b45309,
    /// `.md-status-bad` red #b91c1c) in the app's status tones: amber is `info` (the tiles'
    /// Borderline and Above optimal), red is `urgent` (#B91C1C, the web's own). Nil: plain.
    nonisolated static func gradeColor(_ grade: MyData.Grade?) -> Color? {
        switch grade {
        case .warn: Color.status("info")
        case .bad: Color.status("urgent")
        case .ok, nil: nil
        }
    }

    /// What VoiceOver says for this row's value, its grade words included (the hidden column's
    /// copies say it too, unheard).
    func spokenLabel(_ value: String, previous: String?) -> String {
        Self.spoken(value, grade: gradeWords ?? note, previous: previous)
    }

    /// What VoiceOver says for a value: "3.4, above optimal, previous 2.9" (MyDataRows.tsx MetricRow).
    nonisolated static func spoken(_ value: String, grade: String?, previous: String? = nil) -> String {
        [value, grade, previous.map { "previous \($0)" }].compactMap { $0 }.joined(separator: ", ")
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
    /// A vital's grade colour (`ValueRow.gradeColor`); nil draws it plain.
    var color: Color? = nil
    /// What VoiceOver says for the value, its grade included; nil says the value.
    var spoken: String? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(value)
                .font(.system(.title, design: .rounded).weight(.semibold))
                .foregroundStyle(color ?? .primary)
                .accessibilityLabel(spoken ?? value)
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
    /// The rows of `size` the line is drawn over (a row's ink band, US-62 AC8a); nil, all of it.
    var band: ClosedRange<CGFloat>? = nil

    var body: some View {
        if points.count >= 2 {
            Canvas { context, size in
                let (low, high) = Self.range(points)
                let (top, bottom) = (band?.lowerBound ?? 0, band?.upperBound ?? size.height)
                let pad = 2.0
                let spot = { (index: Int) in
                    CGPoint(x: pad + Double(index) / Double(self.points.count - 1) * (size.width - pad * 2),
                            y: bottom - pad - (self.points[index] - low) / (high - low) * (bottom - top - pad * 2))
                }
                var line = Path()
                line.move(to: spot(0))
                for index in points.indices.dropFirst() { line.addLine(to: spot(index)) }
                var area = line
                area.addLine(to: CGPoint(x: size.width - pad, y: bottom))
                area.addLine(to: CGPoint(x: pad, y: bottom))
                area.closeSubpath()
                context.fill(area, with: .linearGradient(Gradient(colors: [tint.opacity(0.125), tint.opacity(0)]),
                                                         startPoint: CGPoint(x: 0, y: top), endPoint: CGPoint(x: 0, y: bottom)))
                context.stroke(line, with: .color(tint), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                let last = spot(points.count - 1)
                context.fill(Path(ellipseIn: CGRect(x: last.x - 2, y: last.y - 2, width: 4, height: 4)), with: .color(tint))
            }
            .frame(width: size.width, height: size.height)
            .accessibilityHidden(true)
        }
    }

    /// The vertical range the line is drawn over: its points' lowest to highest, widened about
    /// their middle to at least ±5% of the latest point, so a tiny change draws nearly flat
    /// (US-62 AC8a). Points that all equal zero keep a span of one. Twin of health-core's
    /// `trendRange` (recent-trend.ts), tested on the same cases.
    nonisolated static func range(_ points: [Double]) -> (low: Double, high: Double) {
        let low = points.min()!, high = points.max()!
        let wide = max(high - low, 0.1 * abs(points.last!))
        let span = wide == 0 ? 1 : wide
        let middle = (low + high) / 2
        return (middle - span / 2, middle + span / 2)
    }
}
