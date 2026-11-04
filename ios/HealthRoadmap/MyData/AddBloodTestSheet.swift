import SwiftUI

/// PROTOTYPE (My health, round 7): "Add blood test". The tests My health lists (the core blood
/// tests and the record's own lab tests), matched by name as the user types; a pick opens that
/// test's usual entry sheet. A name that matches none cannot be added here yet: the engine has
/// no add for a test the record does not hold, and its lab catalogue is not reachable from Swift.
struct AddBloodTestSheet: View {
    let tests: [MyData.Row]
    /// The picked test; the caller opens its entry once this sheet has gone.
    let pick: (MyData.Row) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    var body: some View {
        NavigationStack {
            List {
                ForEach(matches) { test in
                    Button {
                        pick(test)
                        dismiss()
                    } label: {
                        HStack {
                            Text(test.label)
                            Spacer()
                            Text(test.unit).foregroundStyle(.secondary)
                        }
                    }
                    .tint(.primary)
                }
                if matches.isEmpty {
                    Text("\u{201C}\(typed)\u{201D} is not on the list. A test the app does not know cannot be added on iPhone yet.")
                        .foregroundStyle(.secondary)
                }
            }
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Type a blood test name")
            .navigationTitle("Add blood test")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private var typed: String { search.trimmingCharacters(in: .whitespaces) }

    private var matches: [MyData.Row] {
        typed.isEmpty ? tests : tests.filter { $0.label.localizedCaseInsensitiveContains(typed) }
    }
}
