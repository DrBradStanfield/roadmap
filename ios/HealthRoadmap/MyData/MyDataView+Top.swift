import SwiftUI

/// My health's title row, jump pills and urgent banner. Split out of MyDataView.swift.
extension MyDataView {
    /// The title with the person button, lab upload and Sync, as a row so nothing holds space
    /// under it; then the urgent banner, only when a card is urgent.
    @ViewBuilder
    func top(_ page: HealthPage, proxy: ScrollViewProxy) -> some View {
        Section {
            let title = Text("My health").font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
            let buttons = HStack(spacing: 14) {
                settingsButton
                recordButtons
            }
            .buttonStyle(.borderless)
            .labelStyle(.iconOnly)
            .font(.title3)
            // The buttons go under the title when both do not fit: beside them at the largest
            // sizes, the title broke mid-word ("heal th", TextSizeLayoutTests, US-25 AC26).
            VStack(alignment: .leading, spacing: 2) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 14) { title.fixedSize(); Spacer(); buttons }
                    VStack(alignment: .leading, spacing: 8) { title; buttons }
                }
                // App Review 1.4.1 (US-73 AC13): one line on an SE at the default size, shrunk a
                // little rather than cut; it wraps at larger sizes. The foot's disclaimer stays.
                Text(EducationNote.myHealth)
                    .font(.footnote)
                    .foregroundStyle(Color.status(nil))
                    .lineLimit(typeSize <= .large ? 1 : nil)
                    .minimumScaleFactor(0.85)
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 8, leading: 4, bottom: 0, trailing: 4))
            .listRowSeparator(.hidden)
            // The jump pills (Brad, round 6): they scroll with the page; equal widths across the cards' width (round 7).
            // One above another at accessibility sizes, where three across cut each to "Bl…".
            (typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))) {
                ForEach(HealthTopic.pills) { topic in
                    Button {
                        analytics?.event(.jumpPillTapped)
                        withAnimation { proxy.scrollTo(topic.anchor, anchor: .top) }
                    } label: {
                        // One line, shrunk at the largest sizes rather than cut to "Blood te…" (TextSizeLayoutTests).
                        Text(topic.title.title).lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .tint(.primary)
                }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            .listRowSeparator(.hidden)
            if let urgent = page.urgent {
                Button {
                    withAnimation { proxy.scrollTo(urgent.anchor, anchor: .center) }
                } label: {
                    Label("Needs attention: \(urgent.title)", systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline.weight(.semibold))
                        // White was hard to read on dark mode's light red; the page background reads on both reds.
                        .foregroundStyle(Color(.systemBackground))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                }
                .buttonStyle(PressableStyle())
                .accessibilityHint("Scrolls to the card")
                .listRowBackground(RoundedRectangle(cornerRadius: .cardRadius, style: .continuous).fill(Color.status("urgent")).padding(.vertical, 4))
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            }
        }
        .listSectionSpacing(.compact)
    }

    /// Lab upload and Sync: on the title line and on the Blood tests heading.
    @ViewBuilder
    var recordButtons: some View {
        Button { addingLabs = true } label: {
            Label("Add medical records", systemImage: "plus")
        }
        .accessibilityHint("Upload a lab report or clinic letter")
        syncButton
    }

    /// The person button: the settings sheet. Also on the page for a record that cannot be drawn (UndrawnRecord.swift).
    var settingsButton: some View {
        Button { showSettings = true } label: {
            Label("Settings", systemImage: "person.crop.circle")
        }
    }

    /// The Sync sheet, with Disconnect. Also on the page for a record that cannot be drawn.
    var syncButton: some View {
        Button { showSync = true } label: {
            Label("Sync", systemImage: SyncStatusText.symbol(sync.status, provider: sync.provider))
        }
    }
}
