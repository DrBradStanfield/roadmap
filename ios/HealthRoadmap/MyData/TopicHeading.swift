import SwiftUI
import TipKit

/// A My health heading (US-73): a row in the list's own flow, so the pills can scroll to it by
/// `anchor`; any controls at its trailing end (Blood tests: lab upload and Sync, round 7). At the
/// largest sizes a one-word title shrinks to one line and any controls go under it, so no word
/// breaks ("Supplem-ents", TextSizeLayoutTests, US-25 AC26). `tip`: tour tip 3's action, when the
/// tip shows on this heading (US-57 AC7). Split out of MyDataView.swift (US-64 AC23), so the
/// Documents headings share it (US-73 AC12).
struct TopicHeading<Controls: View>: View {
    let title: SectionTitle
    let anchor: String
    var tip: (@MainActor () -> Void)?
    let controls: Controls
    @Environment(\.dynamicTypeSize) private var typeSize

    init(_ title: SectionTitle, anchor: String, tip: (@MainActor () -> Void)? = nil, @ViewBuilder controls: () -> Controls) {
        self.title = title
        self.anchor = anchor
        self.tip = tip
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
            let buttons = HStack(spacing: 14) { controls }
                .buttonStyle(.borderless)
                .labelStyle(.iconOnly)
                .font(.title3)
            let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(spacing: 14))
            let row = layout { text; Spacer(minLength: 0); buttons }
                .frame(maxWidth: .infinity, alignment: .leading)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 20, leading: 4, bottom: 0, trailing: 4))
            .id(anchor)
            if let tip { row.tourTip(BloodTestsTip(), action: tip) } else { row }
        }
        .listSectionSpacing(.compact)
    }
}

extension TopicHeading where Controls == EmptyView {
    init(_ title: SectionTitle, anchor: String) {
        self.init(title, anchor: anchor) { EmptyView() }
    }
}
