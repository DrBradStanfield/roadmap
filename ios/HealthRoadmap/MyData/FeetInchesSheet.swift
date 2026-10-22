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
    @State private var message: String?
    /// A save is under way: the sheet stays open and its buttons wait.
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 0) {
                        wheel("Feet", selection: $feet, values: 1...8, unit: "ft")
                        wheel("Inches", selection: $inches, values: 0...11, unit: "in")
                    }
                } footer: {
                    if let message {
                        Text(message).foregroundStyle(.red)
                    } else if let current {
                        Text("Now \(current.text)")
                    }
                }
            }
            .navigationTitle("Height")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let height = MyData.FeetInches(feet: feet, inches: inches)
                        SheetSave.run($saving, { await save(height) }) { SheetSave.close($0, dismiss, $message) }
                    }
                    .disabled(saving)
                }
            }
            .onAppear {
                if let current {
                    feet = current.feet
                    inches = current.inches
                }
            }
            .onChange(of: feet) { message = nil }
            .onChange(of: inches) { message = nil }
        }
        .interactiveDismissDisabled(saving)
        .pinsRecord()
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
