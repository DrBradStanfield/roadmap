import SwiftUI

/// A My health heading (US-73): a row in the list's own flow, so the pills can scroll to it by
/// `anchor`; any controls at its trailing end ("Upload labs", US-73 AC14). When the title and the
/// controls do not fit on one line the controls go under it, and at the largest sizes a one-word
/// title shrinks to one line, so no word breaks ("Supplem-ents", TextSizeLayoutTests, US-25 AC26). `tourTip`: tour tip 3
/// shows on this heading (US-57 AC7). Split out of MyDataView.swift (US-64 AC23), so the
/// Documents headings share it (US-73 AC12).
struct TopicHeading<Controls: View>: View {
    let title: SectionTitle
    let anchor: String
    let tourTip: Bool
    let controls: Controls

    init(_ title: SectionTitle, anchor: String, tourTip: Bool = false, @ViewBuilder controls: () -> Controls) {
        self.title = title
        self.anchor = anchor
        self.tourTip = tourTip
        self.controls = controls()
    }

    var body: some View {
        Section {
            let text = title
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color(.label))
                .lineLimit(title.title.contains(" ") ? nil : 1)
                .minimumScaleFactor(0.7)
                .accessibilityAddTraits(.isHeader)
            // As the title row (MyDataView+Top.swift): beside the title when both fit unbroken, else under it.
            // ViewThatFits measures the title at its ideal width. A List's own Label style reports a
            // wrong one (40 pt wide, hundreds tall under fixedSize), which grew the row and broke the
            // title, so a hidden plain copy holds the one-line size and the title draws over it
            // (TextSizeLayoutTests, the room under the banner).
            let line = text.labelStyle(.titleAndIcon).fixedSize(horizontal: true, vertical: false).hidden()
            let row = ViewThatFits(in: .horizontal) {
                HStack(spacing: 14) { line.overlay(alignment: .topLeading) { text }; Spacer(minLength: 0); controls }
                VStack(alignment: .leading, spacing: 8) { text; controls }
            }
            .buttonStyle(.borderless)
            .font(.body)
            .frame(maxWidth: .infinity, alignment: .leading)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: Self.rowTop, leading: 4, bottom: 0, trailing: 4))
            // The scroll id outermost, over the tip's modifiers, so no wrapper can hide it from the
            // list: under TipKit's popoverTip it did, and scrolls to it did nothing (docs/gotchas.md
            // 2026-11-27, second entry).
            Group { if tourTip { row.tourTip(BloodTestsTip(), rowTop: Self.rowTop) } else { row } }
                .id(anchor)
        }
        .listSectionSpacing(.compact)
    }

    /// The room above a heading, in its row: the tour counts it as the heading's (`tourTip`).
    static let rowTop: CGFloat = 20
}

extension TopicHeading where Controls == EmptyView {
    init(_ title: SectionTitle, anchor: String) {
        self.init(title, anchor: anchor) { EmptyView() }
    }
}
