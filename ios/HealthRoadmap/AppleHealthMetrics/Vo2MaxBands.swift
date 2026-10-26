import Foundation

/// A VO2 max fitness band (US-56 AC8): FRIEND percentiles, not Apple's own cut-points.
enum Vo2MaxBand: CaseIterable {
    case low, belowAverage, aboveAverage, high

    var label: String {
        switch self {
        case .low: "Low"
        case .belowAverage: "Below Average"
        case .aboveAverage: "Above Average"
        case .high: "High"
        }
    }
}

/// The person's VO2 max bands (US-56 AC8, display only, AC1): their row of FRIEND 2022's
/// treadmill table, served by the engine on My data (`vo2Bands`, ios/engine/my-data.ts) for
/// their sex and age today. Low is below P20, Below Average to P50, Above Average to P80,
/// High from P80; each band includes its lower bound. Only the table comes out of the
/// engine: a VO2 max never goes in.
struct Vo2MaxBands: Decodable, Equatable {
    /// "male" or "female"
    let sex: String
    let fromAge: Int
    let toAge: Int
    /// mL/kg/min
    let p20: Double
    let p50: Double
    let p80: Double

    /// A value to one decimal: what the page shows, plots and places in a band, so a reading
    /// never shows on one side of a cut-point and is placed on the other.
    static func shown(_ value: Double) -> Double { (value * 10).rounded(.toNearestOrEven) / 10 }

    func band(_ value: Double) -> Vo2MaxBand {
        let shown = Self.shown(value)
        return shown < p20 ? .low : shown < p50 ? .belowAverage : shown < p80 ? .aboveAverage : .high
    }

    /// "women aged 40 to 49", as the legend's heading ends.
    var title: String { "\(sex == "male" ? "men" : "women") aged \(fromAge) to \(toAge)" }

    /// The legend's range, in the values the page shows: "Below 19.7", "19.7 to 25.6", "33.0 and above".
    func range(_ band: Vo2MaxBand) -> String {
        let text = { LiveMetric.vo2Max.text($0) }
        return switch band {
        case .low: "Below \(text(p20))"
        case .belowAverage: "\(text(p20)) to \(text(p50 - 0.1))"
        case .aboveAverage: "\(text(p50)) to \(text(p80 - 0.1))"
        case .high: "\(text(p80)) and above"
        }
    }

    /// "Above Average, 25.7 to 32.9 millilitres per kilogram per minute"; "Low, below 19.7 …".
    func spoken(_ band: Vo2MaxBand) -> String {
        let range = band == .low ? "below \(LiveMetric.vo2Max.text(p20))" : range(band)
        return "\(band.label), \(range) \(LiveMetric.vo2Max.spokenUnit)"
    }

    /// The three cut-points, where the chart draws its thin rules.
    var cuts: [Double] { [p20, p50, p80] }

    /// The chart's value axis: every band and every value, with room above and below.
    func yDomain(values: [Double]) -> ClosedRange<Double> {
        let pad = max(3, (p80 - p20) / 4)
        return ((values + [p20]).min()! - pad).rounded(.down)...((values + [p80]).max()! + pad).rounded(.up)
    }

    /// A band's shading on that axis: the outer two run to its ends.
    func shade(_ band: Vo2MaxBand, in domain: ClosedRange<Double>) -> ClosedRange<Double> {
        switch band {
        case .low: domain.lowerBound...p20
        case .belowAverage: p20...p50
        case .aboveAverage: p50...p80
        case .high: p80...domain.upperBound
        }
    }
}

/// A My data field read leniently: a malformed one reads as nil, so it never blanks the tab.
struct Lenient<Value: Decodable & Sendable>: Decodable, Sendable {
    let value: Value?

    init(from decoder: Decoder) throws { value = try? Value(from: decoder) }
}
