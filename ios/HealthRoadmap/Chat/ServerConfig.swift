import Foundation

/// Where the app's chat and lab upload go (US-52, ios/architecture.md D8): Brad's
/// education server, never Anthropic directly (the phone holds no key).
enum ServerConfig {
    static var baseURL: URL {
        #if DEBUG
        // A development server, for a DEBUG build only (scheme environment or test runner).
        if let override = ProcessInfo.processInfo.environment["HEALTH_ROADMAP_SERVER"], let url = URL(string: override) {
            return url
        }
        #endif
        #if DEBUG && targetEnvironment(simulator)
        // The simulator talks to a server on this Mac (`npm run start`, port 3000).
        return URL(string: "http://127.0.0.1:3000")!
        #else
        // The education Fly app: Brad kept it as the release host (launch-checklist.md, step 2).
        return URL(string: "https://health-tool-edu.fly.dev")!
        #endif
    }
}
