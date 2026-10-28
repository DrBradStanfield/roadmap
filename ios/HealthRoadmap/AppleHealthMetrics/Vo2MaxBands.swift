import Foundation

/// A VO2 max fitness band (US-56 AC8): FRIEND 2022 percentiles; from 60, Low uses Apple's Low
/// Cardio Fitness alert line.
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
/// their sex and age today. Low is below `p20`, the Low line (FRIEND's P20; from 60, Apple's
/// Low Cardio Fitness alert line), Below Average to P50, Above Average to P80, High from P80; each band includes
/// its lower bound, and a band with no room is left out. Only the table comes out of the
/// engine: a VO2 max never goes in.
struct Vo2MaxBands: Decodable, Equatable {
    /// "male" or "female"
    let sex: String
    let fromAge: Int
    let toAge: Int
    /// The Low line, mL/kg/min: FRIEND's P20, or from 60 Apple's 18 (men) or 15 (women).
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

    /// A band's lower bound and the next one's (nil past either end): the Low line can sit above
    /// P50 (men 80 to 89, Apple's 18 over FRIEND's 17.6), and then Below Average has no room.
    private func bounds(_ band: Vo2MaxBand) -> (from: Double?, below: Double?) {
        switch band {
        case .low: (nil, p20)
        case .belowAverage: (p20, p50)
        case .aboveAverage: (max(p20, p50), p80)
        case .high: (max(p20, p80), nil)
        }
    }

    /// The bands with room, low to high: the legend and the shading leave out an empty one.
    var present: [Vo2MaxBand] {
        Vo2MaxBand.allCases.filter { band in
            let (from, below) = bounds(band)
            return from.flatMap { from in below.map { from < $0 } } ?? true
        }
    }

    /// "women aged 40 to 49", as the legend's heading ends.
    var title: String { "\(sex == "male" ? "men" : "women") aged \(fromAge) to \(toAge)" }

    /// The legend's range, in the values the page shows: "Below 19.7", "19.7 to 25.6", "33.0 and above".
    func range(_ band: Vo2MaxBand) -> String {
        let text = { LiveMetric.vo2Max.text($0) }
        return switch band {
        case .low: "Below \(text(p20))"
        case .belowAverage: "\(text(p20)) to \(text(p50 - 0.1))"
        case .aboveAverage: "\(text(max(p20, p50))) to \(text(p80 - 0.1))"
        case .high: "\(text(max(p20, p80))) and above"
        }
    }

    /// "Above Average, 25.7 to 32.9 millilitres per kilogram per minute"; "Low, below 19.7 …".
    func spoken(_ band: Vo2MaxBand) -> String {
        let range = band == .low ? "below \(LiveMetric.vo2Max.text(p20))" : range(band)
        return "\(band.label), \(range) \(LiveMetric.vo2Max.spokenUnit)"
    }

    /// The cut-points between the bands shown, where the chart draws its thin rules.
    var cuts: [Double] { present.dropFirst().compactMap { bounds($0).from } }

    /// The chart's value axis: every band and every value, with room above and below.
    func yDomain(values: [Double]) -> ClosedRange<Double> {
        let pad = max(3, (p80 - p20) / 4)
        return ((values + [p20]).min()! - pad).rounded(.down)...((values + [p80]).max()! + pad).rounded(.up)
    }

    /// A band's shading on that axis: the outer two run to its ends.
    func shade(_ band: Vo2MaxBand, in domain: ClosedRange<Double>) -> ClosedRange<Double> {
        let (from, below) = bounds(band)
        return (from ?? domain.lowerBound)...(below ?? domain.upperBound)
    }
}

/// A My data field read leniently: a malformed one reads as nil, so it never blanks the tab.
struct Lenient<Value: Decodable & Sendable>: Decodable, Sendable {
    let value: Value?

    init(from decoder: Decoder) throws { value = try? Value(from: decoder) }
}
