import SwiftUI

/// My health when the record cannot be drawn (lead H114, US-11, US-25 AC16f): the words for why,
/// then the title row's Settings and Sync, so Export, Delete all my data and Disconnect can still
/// be reached. The erase runs from the Settings sheet as it always does, in the same List, so its
/// lock while it runs (AC16d) and the hand-off of its words (`settingsClosed`) stay on their path.
enum UndrawnRecord {
    /// The heading and words My health shows for `hold`; nil when the record is drawn (`.readable`).
    /// Today's words: the problem's when there is one, else "did not load" with none (lead H114).
    static func text(hold: RecordStore.Hold, problem: RecordProblem?) -> (heading: String, words: String)? {
        switch hold {
        case .readable: nil
        case .heldUndrawn, .empty, .unreadable, .predatesErase: (problem?.heading ?? "Your record did not load", problem?.words ?? "")
        }
    }
}

extension MyDataView {
    /// The tab: why the record is not shown, then Settings and Sync, with their words.
    func undrawnPage(_ text: (heading: String, words: String)) -> some View {
        ContentUnavailableView {
            Label(text.heading, systemImage: "exclamationmark.triangle")
        } description: {
            Text(text.words)
        } actions: {
            settingsButton
            syncButton
        }
    }

    /// The settings sheet's first section while the record is not shown: the same words. The
    /// record's section (Export, Delete) follows it in `settingsList`.
    @ViewBuilder
    var undrawnSection: some View {
        if let text = UndrawnRecord.text(hold: store.hold, problem: store.problem) {
            Section {
                ContentUnavailableView(text.heading, systemImage: "exclamationmark.triangle", description: Text(text.words))
            }
        }
    }
}
