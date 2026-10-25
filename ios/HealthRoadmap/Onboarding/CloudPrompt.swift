import SwiftUI

/// When to offer a backup to the person's own cloud (US-57 AC8, AC9): once, after their
/// third save, never while a cloud is connected or a tour tip is still due. Showing it
/// uses it up, whichever button is tapped. Only a count (at most 3) and a done flag are
/// kept, in UserDefaults; never a health value.
final class CloudPrompt {
    private let defaults: UserDefaults
    private static let savesKey = "backup.saves"
    private static let shownKey = "backup.promptShown"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// The person saved something (AC9 says which saves count; the caller decides).
    func saved() {
        let saves = defaults.integer(forKey: Self.savesKey)
        if saves < 3 { defaults.set(saves + 1, forKey: Self.savesKey) }
    }

    /// True when the prompt should show now.
    func isDue(connected: Bool, tourRunning: Bool) -> Bool {
        !connected && !tourRunning && !defaults.bool(forKey: Self.shownKey) && defaults.integer(forKey: Self.savesKey) >= 3
    }

    /// The prompt showed: it never shows again, backed up or not.
    func shown() {
        defaults.set(true, forKey: Self.shownKey)
    }
}

/// The backup prompt (US-57 AC8): "Back up" opens the existing Sync sheet; "Not now"
/// or a swipe closes it. Shown as a sheet by its caller, which marks it shown.
struct CloudPromptView: View {
    let backUp: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Image(systemName: "externaldrive.badge.icloud")
                    .font(.system(size: 44))
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                Text("Back up your record")
                    .font(.title2.bold())
                    .multilineTextAlignment(.center)
                Text("Your record is only on this iPhone. Keep a copy in your own Dropbox or Google Drive, so a lost phone does not lose it. Dr Brad's server never sees it.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                Button {
                    dismiss()
                    backUp()
                } label: {
                    Text("Back up").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6).onAccentLabel()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .accessibilityIdentifier("backup.backUp")
                Button("Not now") { dismiss() }
                    .accessibilityIdentifier("backup.notNow")
            }
            .padding(24)
        }
        .scrollBounceBehavior(.basedOnSize)
        .presentationDetents([.medium, .large])
    }
}
