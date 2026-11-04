import SwiftUI

/// The summary tiles at the top of the plan (US-25 AC22): the web's Quick Stats, drawn as
/// Apple Health cards. Values, units, statuses and the why behind a tap are health-core's
/// statTiles (packages/health-core/src/stat-tiles.ts), shared with the web; this view only draws them.
struct SummaryTiles: View {
    let tiles: [StatTile]
    @Environment(\.dynamicTypeSize) private var textSize
    @Environment(\.analytics) private var analytics
    @State private var opened: StatTile?

    var body: some View {
        // Two across; one at accessibility sizes, where a value would not fit half the width.
        let columns = Array(repeating: GridItem(.flexible(), spacing: 12), count: textSize.isAccessibilitySize ? 1 : 2)
        LazyVGrid(columns: columns, spacing: 12) {
            ForEach(tiles) { tile in
                // Every tile says what it is (US-57 AC5); a known minor's has no why (US-07 AC6).
                let button = Button {
                    opened = tile
                    analytics?.event(.tileExplainerOpened)
                } label: { TileCard(tile: tile) }
                    .buttonStyle(PressableStyle())
                    .accessibilityHint("Shows what it means")
                // At accessibility sizes the one-column grid is taller than the screen, which
                // left the tip no room: it points at the first tile instead (review R3).
                if textSize.isAccessibilitySize, tile.id == tiles.first?.id {
                    button.tourTip(SnapshotTip())
                } else {
                    button
                }
            }
        }
        // One tip for the whole row, never one per tile (Brad 2026-10-25).
        .modifier(SnapshotAnchor(on: !textSize.isAccessibilitySize))
        .sheet(item: $opened) { tile in
            TileExplainerSheet(title: tile.label, about: tile.about, evidence: tile.evidence)
        }
    }
}

/// Tour tip 1 on the whole grid, unless the first tile carries it.
private struct SnapshotAnchor: ViewModifier {
    let on: Bool

    func body(content: Content) -> some View {
        if on { content.tourTip(SnapshotTip(), arrowEdge: .bottom) } else { content }
    }
}

/// One tile: the name in plain text, the value large with its unit, and the status below.
/// Colour only where it carries meaning: the status capsule, in the web's status colours
/// with normal in the brand teal-green (Brad 2026-10-23, 2026-10-30).
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
                StatusCapsule(label: status.label, tone: status.tone)
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
}
