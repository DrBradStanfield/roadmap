import SwiftUI

/// What a summary tile's tap opens (US-57 AC5): a short "what it is", then the why behind
/// the tile, as the web's opened tile shows it (guideline tags, reason, references). Both
/// come from health-core; this view only draws them. A tile with no why (a known minor's,
/// US-07 AC6) shows the "what it is" alone.
struct TileExplainerSheet: View {
    let title: String
    let about: String?
    let evidence: StatTile.Evidence?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let about { Text(about).font(.body) }
                    if let evidence {
                        EvidenceDetails(reason: evidence.reason, guidelines: evidence.guidelines, references: evidence.references,
                                        heading: about == nil ? nil : "The evidence")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
