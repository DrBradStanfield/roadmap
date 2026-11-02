import Foundation
import StoreKit

/// Whether this iPhone's App Store storefront is the US (US-61 AC5): the phone's twin of
/// the web's Liquid market country, deciding whether the plan's supplement cards show
/// Dr Brad's products. StoreKit's answer is kept on the phone, so a launch draws the plan
/// at once with the last one and never waits on StoreKit. No storefront (no Apple ID, or
/// StoreKit cannot say) keeps the last answer; with none saved, it is not the US. Never
/// under the tests, so no test depends on the simulator's account.
enum AppStoreCountry {
    static let key = "appStoreCountryIsUS"

    /// The last answer StoreKit gave; false before it has given one.
    static func saved(in defaults: UserDefaults = .app) -> Bool {
        #if DEBUG
        if let forced { return forced }
        #endif
        return !testing && defaults.bool(forKey: key)
    }

    /// StoreKit's answer now, kept for the next launch.
    static func current(in defaults: UserDefaults = .app) async -> Bool {
        #if DEBUG
        if let forced { return forced }
        #endif
        guard !testing else { return false }
        return remember(await Storefront.current?.countryCode, in: defaults)
    }

    /// StoreKit's country code, kept for the next launch. Nil (StoreKit cannot say now) keeps
    /// the saved answer and writes nothing, so a passing gap never drops a US user's products.
    static func remember(_ countryCode: String?, in defaults: UserDefaults) -> Bool {
        guard let countryCode else { return defaults.bool(forKey: key) }
        let isUS = countryCode == "USA"
        defaults.set(isUS, forKey: key)
        return isUS
    }

    private static var testing: Bool {
        Analytics.isTesting(environment: ProcessInfo.processInfo.environment, arguments: ProcessInfo.processInfo.arguments)
    }

    #if DEBUG
    /// DEBUG builds only (compiled out of Release): the launch argument `-StorefrontCountry USA`
    /// (or any other code, `NZL` say) stands in for StoreKit, for simulator checks and screenshots.
    static var forced: Bool? {
        UserDefaults.standard.string(forKey: "StorefrontCountry").map { $0 == "USA" }
    }
    #endif
}
