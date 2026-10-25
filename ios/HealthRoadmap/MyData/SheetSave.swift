import SwiftUI

/// A sheet's save, with the engine off the main thread (US-25 AC21): `saving` is set
/// as the button is tapped, so the sheet's Save, Cancel and swipe-down can wait until
/// the edit lands. A sheet closes only on a save; otherwise the engine's words show.
/// An edit made outside a sheet shows them in `refusalAlert`.
@MainActor
enum SheetSave {
    static func run(_ saving: Binding<Bool>, _ save: @escaping () async -> RecordStore.ApplyResult, then finish: @escaping (RecordStore.ApplyResult) -> Void) {
        saving.wrappedValue = true
        Task {
            let result = await save()
            saving.wrappedValue = false
            finish(result)
        }
    }

    /// The usual end: close on a save, else say why.
    static func close(_ result: RecordStore.ApplyResult, _ dismiss: DismissAction, _ message: Binding<String?>) {
        switch result {
        case .saved: dismiss()
        case .refused(let why, _): message.wrappedValue = why
        }
    }
}

extension View {
    /// "Not saved" with the engine's words, for an edit made outside a sheet (a picker,
    /// a menu, a quick add); dismissing it clears `refusal`.
    func refusalAlert(_ refusal: Binding<String?>) -> some View { messageAlert("Not saved", refusal) }
}
