import SwiftUI

/// A US height on two wheels, feet and inches (US-25 AC17), as the web's two
/// fields take it (InputPanel.tsx). The engine converts it with health-core's
/// `feetInchesToCm` and stores centimetres; the 50 to 250 cm range is its own.
struct FeetInchesSheet: View {
    let current: MyData.FeetInches?
    let save: (MyData.FeetInches) async -> RecordStore.ApplyResult

    @Environment(\.dismiss) private var dismiss
    @State private var feet = 5
    @State private var inches = 7
    /// The save (US-25 AC21e): its words show under the fields; Save, Cancel and swipe-down wait while busy.
    @State private var state: SheetSave.State<SheetSave.NoHeld> = .editing(message: nil)

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 0) {
                        wheel("Feet", selection: $feet, values: 1...8, unit: "ft")
                        wheel("Inches", selection: $inches, values: 0...11, unit: "in")
                    }
                } footer: {
                    if let message = state.message {
                        Text(message).foregroundStyle(.red)
                    } else if let current {
                        Text("Now \(current.text)")
                    }
                }
            }
            .navigationTitle("Height")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(state.busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: submit).disabled(state.busy)
                }
            }
            .onAppear {
                if let current {
                    feet = current.feet
                    inches = current.inches
                }
            }
            .onChange(of: feet) { SheetSave.send(&state, .wordsStale) }
            .onChange(of: inches) { SheetSave.send(&state, .wordsStale) }
        }
        .interactiveDismissDisabled(state.busy)
        .pinsRecord()
    }

    private func submit() {
        let height = MyData.FeetInches(feet: feet, inches: inches)
        guard SheetSave.send(&state, .tapped) else { return }
        Task {
            let result = await save(height)
            SheetSave.send(&state, .landed(result, closes: true, asks: .never))
            if state == .done { dismiss() }
        }
    }

    private func wheel(_ label: String, selection: Binding<Int>, values: ClosedRange<Int>, unit: String) -> some View {
        Picker(label, selection: selection) {
            ForEach(values, id: \.self) { Text("\($0) \(unit)").tag($0) }
        }
        .pickerStyle(.wheel)
        .frame(maxWidth: .infinity)
        .accessibilityLabel(label)
    }
}
