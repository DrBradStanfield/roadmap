import Foundation

extension UserDefaults {
    /// The app's own settings: the phone's defaults, or under DEBUG `--demo-record` the demo
    /// record's suite, so filming never changes the phone's consent, units or prompts.
    static var app: UserDefaults {
        #if DEBUG
        if DemoRecord.isOn { return DemoRecord.defaults }
        #endif
        return .standard
    }
}
