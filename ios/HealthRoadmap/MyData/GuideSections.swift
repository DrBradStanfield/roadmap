import SwiftUI

/// A metric's or a medicine's "about this measure" guide (US-58), laid out as Apple Health's
/// About section: what it is, why it matters, how to measure (or prepare, or how a medicine
/// works), then its sources, each a link to its DOI or URL. The words are health-core's
/// METRIC_GUIDES, served by the engine; this view only lays them out.
struct GuideSections: View {
    let guide: MetricGuide
    /// A metric page sends "Guide seen" once, when the section first shows; a sheet's info button sends "Guide opened".
    var counts = true
    @Environment(\.analytics) private var analytics
    @State private var counted = false

    var body: some View {
        Section {
            part("What it is") { Text(guide.whatItIs) }
                .onAppear {
                    guard counts, !counted else { return }
                    counted = true
                    analytics?.event(.guideSeen)
                }
            part("Why it matters") { Text(guide.whyItMatters) }
            part(guide.howTo.heading) {
                ForEach(guide.howTo.points, id: \.self) { point in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•").accessibilityHidden(true)
                        Text(point)
                    }
                }
            }
        } header: {
            Text("About \(guide.title)")
                .foregroundStyle(Color.primary)
                .textCase(nil)
                .accessibilityAddTraits(.isHeader)
        }
        // Apple Health's larger About title, in the primary colour.
        .headerProminence(.increased)
        Section {
            ForEach(guide.sources, id: \.url) { source in
                if let url = MetricGuide.link(source) {
                    Link(destination: url) {
                        Label(source.label, systemImage: "arrow.up.right.square")
                            .font(.subheadline)
                            .multilineTextAlignment(.leading)
                    }
                    .accessibilityHint("Opens in Safari")
                } else {
                    Text(source.label).font(.subheadline)
                }
            }
        } header: {
            Text("Sources").accessibilityAddTraits(.isHeader)
        }
    }

    /// One part: its heading, read by VoiceOver as a heading, then its text.
    private func part(_ heading: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(heading)
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            content()
        }
        .padding(.vertical, 4)
    }
}

/// A medicine's guide in a sheet (US-58 AC5): the same sections as a metric page's.
struct GuideSheet: View {
    let guide: MetricGuide
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List { GuideSections(guide: guide, counts: false) }
                .listStyle(.insetGrouped)
                .navigationTitle(guide.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
        }
        .presentationDetents([.medium, .large])
    }
}
