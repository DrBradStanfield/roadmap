import SwiftUI

/// A US height on two wheels, feet and inches (US-25 AC17), as the web's two
/// fields take it (InputPanel.tsx). The engine converts it with health-core's
/// `feetInchesToCm` and stores centimetres; the 50 to 250 cm range is its own.
struct FeetInchesSheet: View {
    let current: MyData.FeetInches?
    let save: (MyData.FeetInches) -> RecordStore.ApplyResult

    @Environment(\.dismiss) private var dismiss
    @State private var feet = 5
    @State private var inches = 7
    @State private var message: String?

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
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        switch save(MyData.FeetInches(feet: feet, inches: inches)) {
                        case .saved: dismiss()
                        case .refused(let why, _): message = why
                        }
                    }
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
