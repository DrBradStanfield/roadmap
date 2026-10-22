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

    /// The label on an accent-filled button: OnAccent while it can be tapped, the
    /// system's dimmed colour while disabled (review R3).
    func onAccentLabel() -> some View { modifier(OnAccentLabel()) }
}

private struct OnAccentLabel: ViewModifier {
    @Environment(\.isEnabled) private var enabled

    func body(content: Content) -> some View {
        content.foregroundStyle(enabled ? Color.onAccent : Color.secondary)
    }
}
