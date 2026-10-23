import SwiftUI

/// The summary tiles at the top of the plan (US-25 AC22): the web's Quick Stats, drawn as
/// Apple Health cards. Values, units, statuses and the why behind a tap are health-core's
/// statTiles (packages/health-core/src/stat-tiles.ts), shared with the web; this view only draws them.
struct SummaryTiles: View {
    let tiles: [StatTile]
    @Environment(\.dynamicTypeSize) private var textSize
    @State private var opened: StatTile?

    var body: some View {
        // Two across; one at accessibility sizes, where a value would not fit half the width.
        let columns = Array(repeating: GridItem(.flexible(), spacing: 12), count: textSize.isAccessibilitySize ? 1 : 2)
        LazyVGrid(columns: columns, spacing: 12) {
            ForEach(tiles) { tile in
                // A tile with no why (a known minor's, US-07 AC6) is not a button.
                Button { opened = tile } label: { TileCard(tile: tile) }
                    .buttonStyle(PressableStyle())
                    .disabled(tile.evidence == nil)
                    .accessibilityHint(tile.evidence == nil ? "" : "Shows why")
            }
        }
        .sheet(item: $opened) { tile in
            if let evidence = tile.evidence { TileEvidenceSheet(title: tile.label, evidence: evidence) }
        }
    }
}

/// One tile: the name in plain text, the value large with its unit, and the status below.
/// Colour only where it carries meaning: the status capsule (Brad 2026-10-23).
private struct TileCard: View {
    let tile: StatTile

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(tile.label)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
                .lineLimit(2)
            CardValue(value: tile.value, unit: tile.unit)
            if let status = tile.status {
                Text(status.label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background((Self.tones[status.tone ?? ""] ?? .gray).softInDark.opacity(0.18), in: Capsule())
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        // One sentence for VoiceOver: "BMI, 25.2, Overweight".
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([tile.label, "\(tile.value) \(tile.unit)", tile.status?.label].compactMap { $0 }.joined(separator: ", "))
    }

    /// The web's status colours; no tone is gray.
    static let tones: [String: Color] = ["normal": .green, "info": .blue, "attention": .orange, "urgent": .red]
}

/// What a tile's tap shows, as the web's opened tile: the guideline tags, the reason and the references.
private struct TileEvidenceSheet: View {
    let title: String
    let evidence: StatTile.Evidence
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                EvidenceDetails(reason: evidence.reason, guidelines: evidence.guidelines, references: evidence.references)
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
