import SwiftUI

/// What a number box accepts as it is typed (Brad 2026-10-22, US-25 AC17b): digits,
/// one decimal mark (either, as the web's `parseLocalisedNumber` reads both) and no
/// more digits than the field can hold. A first guard only: the engine still checks
/// each value's range.
struct TypedNumber {
    /// Most digits before the decimal mark.
    let whole: Int
    /// Most digits after it; 0 allows no decimal mark at all.
    let decimals: Int

    /// Blood pressure: whole mmHg, three digits.
    static let pressure = TypedNumber(whole: 3, decimals: 0)
    /// A measurement or blood test: five whole digits (PSA's range ends at 10000) and three decimals.
    static let value = TypedNumber(whole: 5, decimals: 3)
    /// A supplement dose: up to 99999.99, the web's own limit (vitamin D runs to 50,000 IU).
    static let dose = TypedNumber(whole: 5, decimals: 2)

    /// Whether `text` fits this field. Anything else is refused, never rewritten: a
    /// rewrite could turn a paste of "1,234.5" into a different number (review R2).
    func accepts(_ text: String) -> Bool {
        let parts = text.split(separator: /[.,]/, maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count <= (decimals > 0 ? 2 : 1),
              parts.allSatisfy({ $0.allSatisfy { $0.isASCII && $0.isNumber } })
        else { return false }
        return parts[0].count <= whole && (parts.count == 1 || parts[1].count <= decimals)
    }

    /// The text to put back after a change from `old` to `new`, or nil to keep `new`.
    /// Never an `old` that breaks the rule itself (a loaded 100000 IU dose): putting
    /// that back would flip between two refused texts forever (re-check R5).
    func revert(old: String, new: String) -> String? {
        accepts(new) || !accepts(old) ? nil : old
    }
}

extension View {
    /// While the person edits the box (`editing`), a change that breaks `kind` is
    /// undone. A value the sheet loads is never touched (review R1: a stored
    /// 100000 IU dose must not become 10000).
    func typedNumber(_ text: Binding<String>, _ kind: TypedNumber, editing: Bool) -> some View {
        onChange(of: text.wrappedValue) { old, new in
            if editing, let back = kind.revert(old: old, new: new) { text.wrappedValue = back }
        }
    }
}

extension TypedNumber {
    /// A typed number by the web's rule: the engine's `readNumber` (ios/engine/my-data.ts)
    /// over health-core's `parseLocalisedNumber`. Arabic-Indic digits and decimal mark
    /// become ASCII, JavaScript's `trim` runs, a comma is a decimal mark, and only a plain
    /// decimal reads; anything else is nil. Pure Swift, so typing never waits on the engine
    /// (US-25 AC21); NumberReadingTests holds it to the engine's own on the edge cases.
    static func read(_ text: String) -> Double? {
        var scalars = text.unicodeScalars.map { scalar -> Unicode.Scalar in
            switch scalar.value {
            case 0x0660...0x0669: Unicode.Scalar(scalar.value - 0x0660 + 0x30)!
            case 0x06F0...0x06F9: Unicode.Scalar(scalar.value - 0x06F0 + 0x30)!
            case 0x066B, 0x2C: "."
            default: scalar
            }
        }[...]
        while let first = scalars.first, isJavaScriptSpace(first) { scalars.removeFirst() }
        while let last = scalars.last, isJavaScriptSpace(last) { scalars.removeLast() }
        // ^[+-]?(\d+(\.\d*)?|\.\d+)$, the ASCII digits only.
        var rest = scalars
        if let sign = rest.first, sign == "+" || sign == "-" { rest.removeFirst() }
        let whole = rest.prefix { ("0"..."9").contains($0) }.count
        rest.removeFirst(whole)
        var decimals = 0
        if rest.first == "." {
            rest.removeFirst()
            decimals = rest.prefix { ("0"..."9").contains($0) }.count
            rest.removeFirst(decimals)
        }
        guard rest.isEmpty, whole + decimals > 0,
              let number = Double(String(String.UnicodeScalarView(scalars))), number.isFinite else { return nil }
        // The engine answers in JSON, which writes -0 as 0.
        return number == 0 ? 0 : number
    }

    /// What JavaScript's `trim` removes: its WhiteSpace and LineTerminator.
    private static func isJavaScriptSpace(_ scalar: Unicode.Scalar) -> Bool {
        [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0xFEFF, 0x2028, 0x2029].contains(scalar.value)
            || scalar.properties.generalCategory == .spaceSeparator
    }
}
