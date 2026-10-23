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
        .alert("Not saved", isPresented: Binding(get: { refusal != nil }, set: { if !$0 { refusal = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(refusal ?? "")
        }
    }

    /// A choice: the question, the recorded answer as a menu, and the hint beneath.
    /// "Not recorded" and "Other (recorded)" show only while they are the answer.
    private func choice(label: String, hint: String?, options: [FormOption], value: String) -> some View {
        let pickable = options.filter { $0.disabled != true }
        let shown = options.first { $0.value == value }?.label ?? "Select..."
        return labelled(label, hint: hint) {
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

    /// The question on the left, wrapped as long as it needs, the answer on the right, the hint below.
    private func labelled(_ label: String, hint: String?, @ViewBuilder trailing: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline) {
                    Text(label)
                    Spacer(minLength: 12)
                    trailing()
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(label)
                    trailing()
                }
            }
            if let hint {
                Text(hint).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .contentShape(Rectangle())
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
    @State private var message: String?
    /// A save is under way: the sheet stays open and its buttons wait.
    @State private var saving = false

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
                if let message {
                    Text(message).foregroundStyle(.red)
                }
                if !current.isEmpty {
                    Button("Clear this date") { submit("") }.disabled(saving)
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { submit(picked) }.disabled(picked.isEmpty || saving) }
            }
            .onAppear { picked = months.contains(current) ? current : ordered.first ?? "" }
        }
        .interactiveDismissDisabled(saving)
    }

    /// A past date lists the latest month first; a future one the soonest.
    private var ordered: [String] { future ? months : months.reversed() }

    private func submit(_ month: String) {
        SheetSave.run($saving, { await save(month) }) { SheetSave.close($0, dismiss, $message) }
    }
}
