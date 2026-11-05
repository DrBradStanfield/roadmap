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
    /// What the person typed, kept while the box shows only its conversion (US-54 AC6b): a
    /// switch back shows it again and a save reads it, never the rounded text shown.
    private var typed: Entry?
    /// The box as the last switch left it; a keystroke since makes the shown text the answer.
    private var converted: Entry?

    private struct Entry: Equatable {
        var text, feet, inches: String
        var us: Bool
    }

    private var entry: Entry {
        get { Entry(text: text, feet: feet, inches: inches, us: us) }
        set { (text, feet, inches, us) = (newValue.text, newValue.feet, newValue.inches, newValue.us) }
    }

    /// What the person typed: kept from before the last switch if nothing was typed since, else the box.
    private var answer: Entry { entry == converted ? typed ?? entry : entry }

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

    /// An entry's number in its own units, read as `value` reads the box.
    private func number(_ entry: Entry) -> Double? {
        var box = self
        box.entry = entry
        return box.value
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

    /// The other units. A box left alone shows the record's value again; a typed one shows
    /// its conversion, and back in the units it was typed in, what was typed (US-54 AC6b).
    mutating func switchUnits(toUS: Bool, recorded: Double?, recordUnits: String, convert: Convert) async {
        guard toUS != us else { return }
        let mine = answer
        let shown: HealthEngine.Conversion? = if edited, mine.us != toUS, let value = number(mine) { await convert(value, metric, Self.system(mine.us), Self.system(toUS)) } else { nil }
        us = toUS
        if !edited {
            await show(recorded, recordUnits: recordUnits, convert: convert)
        } else if mine.us == toUS {
            entry = mine
            (typed, converted) = (nil, nil)
        } else if let shown {
            fill(shown)
            (typed, converted) = (mine, entry)
        }
    }

    /// What to save, in `recordUnits` (the units the engine's edit reads), or nil when
    /// the person typed nothing here.
    func saved(recordUnits: String, convert: Convert) async -> Double? {
        let mine = answer
        guard edited, let typed = number(mine) else { return nil }
        if Self.system(mine.us) == recordUnits { return typed }
        return await convert(typed, metric, Self.system(mine.us), recordUnits)?.value
    }

    /// A height's edit: feet and inches as typed in them, else what `saved` reads (US-54 AC6b);
    /// nil when nothing typed here can be read.
    func edit(recordUnits: String, convert: Convert) async -> RecordEdit? {
        guard edited else { return nil }
        var mine = self
        mine.entry = answer
        if mine.us { return mine.feetInches.map { .feetInches(feet: $0.feet, inches: $0.inches) } }
        return await saved(recordUnits: recordUnits, convert: convert).map { .profile(height: $0) }
    }

    /// The typed value is `recorded` (in `recordUnits`) to within half the step of the units
    /// it was typed in, 0.1 kg or a whole pound: compared in kilograms, never by the text
    /// shown (US-54 AC5, AC6b).
    func repeats(_ recorded: Double?, recordUnits: String, convert: Convert) async -> Bool {
        guard let recorded, let typed = await saved(recordUnits: "si", convert: convert),
              let kg = await (recordUnits == "si" ? recorded : convert(recorded, metric, recordUnits, "si")?.value),
              let halfStep = await (answer.us ? convert(0.5, metric, "conventional", "si")?.value : 0.05) else { return false }
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
