import SwiftUI

/// One large number box with its unit beside it, holding the web's typing rule while
/// the person edits it (`TypedNumber`). The value entry sheet and onboarding's height
/// and weight screens draw it; each keeps its own focus.
struct BigNumberField<Focus: Hashable>: View {
    let placeholder: String
    @Binding var text: String
    var unit: String?
    var kind: TypedNumber = .value
    let focus: FocusState<Focus>.Binding
    /// The focus value that is this box.
    let field: Focus
    /// What VoiceOver reads, and the UI tests' identifier.
    let label: String
    var id = ""

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            TextField(placeholder, text: $text)
                .analyticsMasked()
                .keyboardType(kind.decimals > 0 ? .decimalPad : .numberPad)
                .typedNumber($text, kind, editing: focus.wrappedValue == field)
                .font(.system(size: 44, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .focused(focus, equals: field)
                .accessibilityLabel(label)
                .accessibilityIdentifier(id)
            if let unit { Text(unit).font(.title3).foregroundStyle(.secondary) }
        }
    }
}
