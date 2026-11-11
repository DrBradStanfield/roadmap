import SwiftUI

/// One form question from the engine (US-25 AC8), drawn natively: a choice is
/// a menu of the web's options, a month opens a month picker, a number and a
/// dated value open the entry sheet. The words are health-core's; this view
/// only lays them out and hands the answer back. The web twin is a field in
/// InputPanel.tsx's medication and screening sections.
struct FormFieldRow: View {
    let field: FormField
    /// The months a past or future date may name.
    let months: ScreeningMonths
    /// Saves an answer ('' clears it) and says whether it was saved.
    let answer: (String) async -> RecordStore.ApplyResult
    /// A dated value's current row (PSA), and how to open it.
    var measurement: MyData.Row?
    var openMeasurement: () -> Void = {}
    /// The question's guide (US-58 AC5), opened from the info button beside it.
    var guide: MetricGuide?
    /// The plan's suggestions on this question (US-73 AC6), shown first in the info sheet; the
    /// info button then takes the attention colour.
    var suggestions: [Suggestion] = []
    /// A screening group's name (US-73 AC6), drawn in the question's place so
    /// the group takes one row; the question then names the empty answer, or sits under the row.
    var heading: String?
    /// Under the row, each suggestion's description (a screening group) or else its title, one
    /// line (a medicine, Brad 2026-11-05); the full text is behind the info button.
    var describes = false
    @Environment(\.analytics) private var analytics
    @State private var guideShown = false

    @State private var asking: Asking?
    /// Why a menu answer was not saved, in the engine's words.
    @State private var refusal: String?
    /// A menu answer is landing: the menu waits, so a quick change back is never lost.
    @State private var answering = false

    private enum Asking: String, Identifiable {
        case month, number
        var id: String { rawValue }
    }

    var body: some View {
        Group {
            switch field {
            case .choice(_, let label, let hint, let options, let value):
                choice(label: label, hint: hint, options: options, value: value)
            case .month(_, let label, let value, _):
                Button { asking = .month } label: {
                    labelled(label, hint: nil) {
                        Text(value.isEmpty ? "Add" : DayText.month(value))
                            .foregroundStyle(value.isEmpty ? Color.accentColor : .primary)
                    }
                }
                .tint(.primary)
            case .number(_, let label, let hint, let value):
                Button { asking = .number } label: {
                    labelled(label, hint: hint) {
                        Text(value.isEmpty ? "Add" : value)
                            .monospacedDigit()
                            .foregroundStyle(value.isEmpty ? Color.accentColor : .primary)
                    }
                }
                .tint(.primary)
            case .measurement(_, let label, let hint):
                Button(action: openMeasurement) {
                    labelled(label, hint: hint) {
                        if let latest = measurement?.latest {
                            VStack(alignment: .trailing, spacing: 2) {
                                Text(latest.value).font(.body.weight(.semibold)).monospacedDigit()
                                Text(DayText.short(latest.day)).font(.caption).foregroundStyle(.secondary)
                            }
                        } else {
                            Text("Add").foregroundStyle(Color.accentColor)
                        }
                    }
                }
                .tint(.primary)
            }
        }
        .sheet(item: $asking) { asking in
            switch (asking, field) {
            case (.month, .month(_, let label, let value, let future)):
                MonthPickerSheet(title: label, months: future ? months.future : months.past, future: future, current: value, save: answer)
                    .presentationDetents([.medium])
            case (.number, .number(_, let label, _, let value)):
                ValueEntrySheet(title: label, unit: "", current: value.isEmpty ? nil : value, asksForDay: false) { number, _ in
                    // Sent as typed; the engine refuses what the question does not offer (a whole number in range).
                    await answer(SupplementSheet.doseText(number))
                }
                .presentationDetents([.medium])
            default:
                EmptyView()
            }
        }
        .refusalAlert($refusal)
    }

    /// A choice: the question, the recorded answer as a menu, and the hint beneath.
    /// "Not recorded" and "Other (recorded)" show only while they are the answer.
    private func choice(label: String, hint: String?, options: [FormOption], value: String) -> some View {
        let pickable = options.filter { $0.disabled != true }
        // Under a group's name, "Select screening method"; a question ("Discussed…?") goes under the row instead.
        let asks = label.hasSuffix("?")
        let empty = heading == nil || asks ? "Select..." : "Select \(Self.lowercasedFirst(label))"
        let shown = options.first { $0.value == value && !$0.value.isEmpty }?.label ?? empty
        return labelled(label, hint: heading != nil && asks ? [label, hint].compactMap { $0 }.joined(separator: "\n") : hint) {
            Menu {
                Picker(label, selection: Binding(get: { value }, set: { picked in
                    guard picked != value else { return }
                    answering = true
                    Task {
                        if case .refused(let why, _) = await answer(picked) { refusal = why }
                        answering = false
                    }
                })) {
                    ForEach(pickable, id: \.value) { Text($0.label).tag($0.value) }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(shown).multilineTextAlignment(.trailing)
                    Image(systemName: "chevron.up.chevron.down").font(.caption)
                }
            }
            .disabled(answering)
            .accessibilityLabel(label)
            .accessibilityValue(shown)
        }
    }

    /// The question, then its guide's info button when it has one (US-58 AC5).
    private func title(_ label: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(label)
            if guide != nil || !suggestions.isEmpty {
                Button {
                    guideShown = true
                    if let event = Self.opened(guide: guide) { analytics?.event(event) }
                } label: {
                    Image(systemName: suggestions.isEmpty ? "info.circle" : "info.circle.fill")
                        .foregroundStyle(suggestions.isEmpty ? Color.accentColor : Color.status("attention"))
                }
                .buttonStyle(.borderless)
                // A 44-point tap area that leaves the row's layout as it was.
                .padding(12).contentShape(Rectangle()).padding(-12)
                .accessibilityLabel("About \(guide?.title ?? label)")
                // The suggestions' own titles, so VoiceOver says one is inside.
                .accessibilityValue(suggestions.map(\.title).joined(separator: ", "))
                .sheet(isPresented: $guideShown) { GuideSheet(guide: guide, suggestions: suggestions) }
            }
        }
    }

    /// The info button's event: "Guide opened" only when its sheet shows a guide, never for a
    /// sheet of the plan's suggestions alone (review R7).
    static func opened(guide: MetricGuide?) -> Analytics.Event? {
        guide == nil ? nil : .guideOpened
    }

    /// The question on the left, wrapped as long as it needs, the answer on the right, the hint below.
    private func labelled(_ label: String, hint: String?, @ViewBuilder trailing: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline) {
                    title(heading ?? label)
                    Spacer(minLength: 12)
                    trailing()
                }
                VStack(alignment: .leading, spacing: 6) {
                    title(heading ?? label)
                    trailing()
                }
            }
            if let hint {
                Text(hint).font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(suggestions) { suggestion in
                Text(describes ? suggestion.description : suggestion.title)
                    .font(.footnote)
                    .foregroundStyle(suggestion.priority == "urgent" ? Color.status("urgent") : .primary)
            }
        }
        .contentShape(Rectangle())
    }

    /// "Screening method" to "screening method"; "DEXA scan status" keeps its capitals.
    private static func lowercasedFirst(_ text: String) -> String {
        guard let first = text.first, text.dropFirst().first?.isLowercase == true else { return text }
        return first.lowercased() + text.dropFirst()
    }
}

/// Picks a month for a screening date from the months the engine allows, newest
/// first for a past date and soonest first for a booked one. Clearing is an answer too.
struct MonthPickerSheet: View {
    let title: String
    /// YYYY-MM, oldest first.
    let months: [String]
    /// A booked follow-up, not a past screening.
    let future: Bool
    let current: String
    let save: (String) async -> RecordStore.ApplyResult

    @Environment(\.dismiss) private var dismiss
    @State private var picked = ""
    /// The save (US-25 AC21e): its words show under the fields; Save, Cancel and swipe-down wait while busy.
    @State private var state: SheetSave.State<SheetSave.NoHeld> = .editing(message: nil)

    var body: some View {
        sheet.pinsRecord()
    }

    private var sheet: some View {
        NavigationStack {
            Form {
                Picker(title, selection: $picked) {
                    ForEach(ordered, id: \.self) { Text(DayText.month($0)).tag($0) }
                }
                .pickerStyle(.wheel)
                .labelsHidden()
                if let message = state.message {
                    Text(message).foregroundStyle(.red)
                }
                if !current.isEmpty {
                    Button("Clear this date") { submit("") }.disabled(state.busy)
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(state.busy) }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { submit(picked) }.disabled(picked.isEmpty || state.busy) }
            }
            .onAppear { picked = months.contains(current) ? current : ordered.first ?? "" }
        }
        .interactiveDismissDisabled(state.busy)
    }

    /// A past date lists the latest month first; a future one the soonest.
    private var ordered: [String] { future ? months : months.reversed() }

    private func submit(_ month: String) {
        guard SheetSave.send(&state, .tapped) else { return }
        Task {
            let result = await save(month)
            SheetSave.send(&state, .landed(result, closes: true, asks: .never))
            if state == .done { dismiss() }
        }
    }
}
