import Foundation

/// When to ask for an App Store rating (US-25 AC8). Apple's advice: ask at a moment
/// of success, never on first use, and not often. Ours: once values were saved on
/// three separate days, at the next opening of the plan, once per app version.
/// iOS itself shows the prompt at most three times a year and may skip it.
///
/// Only counts and day stamps are kept, in UserDefaults; never a health value.
final class ReviewPrompt {
    private let defaults: UserDefaults
    private let version: String
    private static let daysKey = "review.daysWithSaves"
    private static let askedKey = "review.askedVersion"

    init(defaults: UserDefaults = .app, version: String = Bundle.main.appVersion) {
        self.defaults = defaults
        self.version = version
    }

    /// The record changed: a day with saves.
    func recordChanged(at now: Date = .now) {
        var days = Set(defaults.stringArray(forKey: Self.daysKey) ?? [])
        guard days.count < 3 else { return }
        days.insert(DayText.iso(now))
        defaults.set(Array(days), forKey: Self.daysKey)
    }

    /// The plan opened. True when this is the moment to ask; asking is then recorded.
    func planOpened() -> Bool {
        let days = defaults.stringArray(forKey: Self.daysKey) ?? []
        guard days.count >= 3, defaults.string(forKey: Self.askedKey) != version else { return false }
        defaults.set(version, forKey: Self.askedKey)
        return true
    }
}

extension Bundle {
    /// "1.0", from the app's Info.plist.
    var appVersion: String { object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }
}
