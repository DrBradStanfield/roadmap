import SwiftUI

/// A sheet that edits the record pins the record it opened on (US-25 AC11,
/// review R1 and R2): the erase it was at and its units. A value typed there is
/// then refused if a sync brought in an erase or a unit change meanwhile,
/// instead of landing in a record the user never saw. `RecordStore.apply` does
/// the check; this only marks the sheet open and closed.
private struct PinsRecord: ViewModifier {
    @Environment(RecordStore.self) private var store: RecordStore?

    func body(content: Content) -> some View {
        content
            .onAppear { store?.pinScreen() }
            .onDisappear { store?.unpinScreen() }
    }
}

extension View {
    /// Put on the root of every sheet that edits the record.
    func pinsRecord() -> some View {
        modifier(PinsRecord())
    }
}
