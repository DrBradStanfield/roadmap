import Foundation

/// A typed height or weight on its onboarding screen (US-54 AC6). Its unit switch is for
/// entry only: the box keeps its own text and units and never writes the record's, which
/// come from the region default and change in My data's Units row. Every conversion is the
/// engine's (`convertJson`, health-core's factors), awaited off the main thread (US-25 AC21).
/// Pure apart from that, so OnboardingStepsTests checks it.
struct TypedAnswer: Equatable {
    /// (value, metric, from, to): a value in the other units, "si" or "conventional".
    typealias Convert = (Double, String, String, String) async -> HealthEngine.Conversion?

    /// "height" or "weight".
    let metric: String
    /// Centimetres, or the weight, as typed.
    var text = ""
    /// A US height's two boxes.
    var feet = ""
    var inches = ""
    var us = false
    /// The person typed here. A box filled from the record and left alone saves nothing,
    /// in any unit: compared by this, never by the text shown (Codex, adversary R1, R2).
    var edited = false
    /// Unit taps so far (Codex): two taps never leave the box as it was, so a conversion
    /// begun for an earlier tap never lands over a later one (`land`).
    private(set) var taps = 0

    /// A unit tap, counted in the tap: the box its conversion starts from.
    mutating func tapped() -> TypedAnswer {
        taps += 1
        return self
    }

    /// `after`, worked out from `before`, lands only if the box is still `before`: a keystroke
    /// or a later tap since wins, so the box never shows text in units it no longer holds.
    mutating func land(_ after: TypedAnswer, from before: TypedAnswer) {
        if self == before { self = after }
    }

    static func system(_ us: Bool) -> String { us ? "conventional" : "si" }

    private var isHeight: Bool { metric == "height" }

    /// A US height as typed, nil until both read as whole numbers. Empty inches are 0:
    /// "5 ft" is a height.
    var feetInches: MyData.FeetInches? {
        guard let feet = Int(feet), let inches = inches.isEmpty ? 0 : Int(inches) else { return nil }
        return MyData.FeetInches(feet: feet, inches: inches)
    }

    /// The box's number in its own units (a US height in inches), nil until it reads as one.
    var value: Double? {
        guard isHeight, us else { return TypedNumber.read(text) }
        return feetInches.map { Double($0.feet * 12 + $0.inches) }
    }

    /// What the page asks while a typed comma cannot be read ("100,500" kg), so Continue is
    /// never disabled without a word (US-02 AC7). No range is needed: a height's or weight's
    /// thousands reading ("1,000" and up) is never inside its range, so a comma there is
    /// always asked about.
    var question: String? { isHeight && us ? nil : TypedNumber.question(text) }

    /// Shows `recorded`, the record's value in `recordUnits`, in the box's own units;
    /// empty boxes when there is none.
    mutating func show(_ recorded: Double?, recordUnits: String, convert: Convert) async {
        let shown: HealthEngine.Conversion? = if let recorded { await convert(recorded, metric, recordUnits, Self.system(us)) } else { nil }
        fill(shown)
    }

    /// The other units. A box left alone shows the record's value again; a typed one is
    /// converted once, and stays the person's.
    mutating func switchUnits(toUS: Bool, recorded: Double?, recordUnits: String, convert: Convert) async {
        guard toUS != us else { return }
        let typed: HealthEngine.Conversion? = if edited, let value { await convert(value, metric, Self.system(us), Self.system(toUS)) } else { nil }
        us = toUS
        if !edited {
            await show(recorded, recordUnits: recordUnits, convert: convert)
        } else if let typed {
            fill(typed)
        }
    }

    /// What to save, in `recordUnits` (the units the engine's edit reads), or nil when
    /// the person typed nothing here.
    func saved(recordUnits: String, convert: Convert) async -> Double? {
        guard edited, let typed = value else { return nil }
        if Self.system(us) == recordUnits { return typed }
        return await convert(typed, metric, Self.system(us), recordUnits)?.value
    }

    /// The typed value is `recorded` (in `recordUnits`) to within half the box's own step,
    /// 0.1 kg or a whole pound: compared in kilograms, never by the text shown (US-54 AC5).
    func repeats(_ recorded: Double?, recordUnits: String, convert: Convert) async -> Bool {
        guard let recorded, let typed = await saved(recordUnits: "si", convert: convert),
              let kg = await (recordUnits == "si" ? recorded : convert(recorded, metric, recordUnits, "si")?.value),
              let halfStep = await (us ? convert(0.5, metric, "conventional", "si")?.value : 0.05) else { return false }
        return abs(typed - kg) < halfStep
    }

    private mutating func fill(_ shown: HealthEngine.Conversion?) {
        if isHeight, us {
            feet = shown?.feetInches.map { String($0.feet) } ?? ""
            inches = shown?.feetInches.map { String($0.inches) } ?? ""
        } else {
            text = shown?.text ?? ""
        }
    }
}
