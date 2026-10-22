import SwiftUI
import UIKit

/// The Reminders section of My data (US-25 AC12): one switch, then what is due and
/// when. Turning it on explains first, then asks iOS's permission. The web twin
/// is the email-reminders control in widget-src (ResultsPanel's remindersSection);
/// the web has no per-category switches since its v1 settings went, so neither
/// does the app. Any per-category choice already in the record is honoured by
/// the engine's schedule.
struct RemindersSection: View {
    @Environment(ReminderScheduler.self) private var scheduler
    @State private var explaining = false
    @State private var refused = false

    var body: some View {
        Section {
            Toggle("Remind me when something is due", isOn: Binding(
                get: { scheduler.optedIn },
                set: { on in
                    if on { explaining = true } else { Task { await scheduler.optOut() } }
                }
            ))
            if scheduler.optedIn {
                switch scheduler.permission {
                case .denied: Button("Notifications are off in Settings. Turn them on") { openSettings() }
                case .notAsked: Button("Allow notifications") { Task { await ask() } }
                case .allowed, nil: EmptyView()
                }
            }
            ForEach(scheduler.reminders?.upcoming ?? [], id: \.category) { item in
                HStack(alignment: .firstTextBaseline) {
                    Text(item.label)
                    Spacer()
                    Text(item.overdue ? "Due now" : item.dueText)
                        .foregroundStyle(item.overdue ? Color.accentColor : .secondary)
                        .monospacedDigit()
                }
            }
        } header: {
            SectionTitle.reminders()
        } footer: {
            Text("Worked out on this iPhone from your record, with nothing sent anywhere. The lock screen says only that a check-up is due, never which one.")
        }
        .alert("Turn on reminders?", isPresented: $explaining) {
            Button("Continue") { Task { await ask() } }
            Button("Not now", role: .cancel) {}
        } message: {
            Text("This iPhone will notify you when a check-up, screening or blood test in your plan is due. iOS will ask if notifications are allowed.")
        }
        .alert("Notifications are off", isPresented: $refused) {
            Button("Open Settings") { openSettings() }
            Button("OK", role: .cancel) {}
        } message: {
            Text("Allow notifications for Health Roadmap in Settings to get reminders.")
        }
    }

    /// Asks iOS; only a refusal points to Settings (a grant with an unreadable record is not one).
    private func ask() async {
        _ = await scheduler.optIn()
        refused = scheduler.permission == .denied
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }
}
