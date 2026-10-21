import SwiftUI
import UIKit

/// The Reminders section of My data (US-25 AC9): one switch, then what is due and
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
            if scheduler.optedIn && !scheduler.permitted {
                Button("Notifications are off in Settings. Turn them on") { openSettings() }
            }
            ForEach(scheduler.reminders?.upcoming ?? [], id: \.category) { item in
                HStack(alignment: .firstTextBaseline) {
                    Text(item.label)
                    Spacer()
                    Text(item.overdue ? "Due now" : Self.month(item.dueAt))
                        .foregroundStyle(item.overdue ? Color.accentColor : .secondary)
                        .monospacedDigit()
                }
            }
        } header: {
            Text("Reminders")
        } footer: {
            Text("Worked out on this iPhone from your record, with nothing sent anywhere. The lock screen says only that a check-up is due, never which one.")
        }
        .alert("Turn on reminders?", isPresented: $explaining) {
            Button("Continue") { Task { refused = !(await scheduler.optIn()) } }
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

    /// "Mar 2027", as the web's reminder emails write it (`formatReminderDate`): a
    /// screening is due in a month, and its stored day is always the 1st.
    private static func month(_ day: String) -> String {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = .gmt
        guard parts.count == 3, let date = utc.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else { return day }
        return date.formatted(Date.FormatStyle(timeZone: .gmt).month(.abbreviated).year())
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }
}
