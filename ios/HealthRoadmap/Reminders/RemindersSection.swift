import SwiftUI
import UIKit

/// The Reminders section of My data (US-25 AC12): one switch, then what is due and
/// when. Turning it on asks iOS's permission at once, with no message of ours first
/// (App Review 5.1.1(iv), Brad 2026-11-09). The web has no in-app switch: its reminders
/// are the email box beside the plan (PlanPdf.tsx, which guards a double submit), turned
/// off by the email's unsubscribe link. The web has no per-category switches since its
/// v1 settings went, so neither does the app. Any per-category choice already in the
/// record is honoured by the engine's schedule.
struct RemindersSection: View {
    @Environment(ReminderScheduler.self) private var scheduler
    @State private var refused = false

    var body: some View {
        Section {
            Toggle("Remind me when something is due", isOn: Binding(
                get: { scheduler.optedIn },
                set: { on in
                    Task { if on { await ask() } else { await scheduler.optOut() } }
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
