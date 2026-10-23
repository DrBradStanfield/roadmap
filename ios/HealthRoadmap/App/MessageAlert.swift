import SwiftUI

extension View {
    /// An alert with one OK button that shows `message` while it is set; dismissing it
    /// clears `message`. Used across the tabs (`refusalAlert`, Sync, Connect).
    func messageAlert(_ title: String, _ message: Binding<String?>) -> some View {
        alert(title, isPresented: Binding(get: { message.wrappedValue != nil }, set: { if !$0 { message.wrappedValue = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(message.wrappedValue ?? "")
        }
    }
}
