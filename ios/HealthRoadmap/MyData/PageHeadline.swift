import SwiftUI

/// A metric page's headline, as Apple Health heads its chart (US-25 AC17, US-56 AC7, AC9):
/// a title ("Latest", "Average", "Range", "Time Asleep"), the value as number and unit pairs
/// (sleep's hours and minutes each with theirs), and the day or span under it.
struct Headline: Equatable {
    struct Part: Hashable {
        let number: String
        let unit: String
    }

    let title: String
    /// Empty when there is nothing to show: the headline says "None".
    var parts: [Part] = []
    var span = ""
}

/// The headline drawn large, shared by every metric page: My data's (MetricDetailView) and
/// Apple Health's (LiveMetricPage, SleepPage).
struct PageHeadline: View {
    let headline: Headline

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(headline.title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if headline.parts.isEmpty { Text("None").font(Self.large) }
                ForEach(headline.parts, id: \.self) { part in
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(part.number).font(Self.large).monospacedDigit().contentTransition(.numericText())
                        if !part.unit.isEmpty { Text(part.unit).font(.title3).foregroundStyle(.secondary) }
                    }
                }
            }
            if !headline.span.isEmpty { Text(headline.span).font(.subheadline).foregroundStyle(.secondary) }
        }
        .accessibilityElement(children: .combine)
    }

    private static let large = Font.system(.largeTitle, design: .rounded).weight(.semibold)
}

extension View {
    /// A metric page's list, shared by MetricDetailView and Apple Health's pages: inset
    /// grouped under an inline title, with the range picker's card right under the title,
    /// as Apple Health's, not the list's 50 pt first-section gap (Brad 2026-10-25).
    func metricPageList(title: String) -> some View {
        listStyle(.insetGrouped)
            .contentMargins(.top, 8, for: .scrollContent)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
    }
}
