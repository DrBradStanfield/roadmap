import Foundation

/// The two clouds the app can keep the record in (US-25 AC11, architecture.md D5),
/// with what signing in to each needs. The raw values are health-core's backend
/// ids, which ios/engine/cloud.ts takes.
enum CloudProvider: String, CaseIterable, Codable, Identifiable, Sendable {
    case dropbox
    case googleDrive = "google-drive"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .dropbox: "Dropbox"
        case .googleDrive: "Google Drive"
        }
    }

    /// The web's own Dropbox app ("App folder" access, /Apps/Health Plan by Dr Brad),
    /// so the phone and the website see one file. A PKCE client id: public by design
    /// (widget-src/standalone/dropbox-config.ts holds the same key).
    static let dropboxAppKey = "xf96vqvjotm5xhx"

    /// An iOS OAuth client in the web's Google Cloud project (project number
    /// 687809032623), because `drive.file` shows only the files that project made.
    /// Created by Brad on 2026-10-22 for bundle id com.drbrad.healthroadmap.
    static let googleIOSClientId = "687809032623-chsdl61oed3k2p95p24bl26oo4aj2lo6.apps.googleusercontent.com"

    var clientId: String {
        switch self {
        case .dropbox: Self.dropboxAppKey
        case .googleDrive: Self.googleIOSClientId
        }
    }

    /// False until the provider's client id exists.
    var isConfigured: Bool { !clientId.isEmpty }

    /// The scheme ASWebAuthenticationSession waits for. Dropbox's is the one its
    /// own iOS SDK uses (`db-<app key>`); Google's is the iOS client's reversed id.
    var callbackScheme: String {
        switch self {
        case .dropbox: "db-\(Self.dropboxAppKey)"
        case .googleDrive: Self.googleIOSClientId.split(separator: ".").reversed().joined(separator: ".")
        }
    }

    /// Must match a redirect URI the provider's console lists, character for character.
    var redirectURI: String {
        switch self {
        case .dropbox: "\(callbackScheme)://2/token"
        case .googleDrive: "\(callbackScheme):/oauth2redirect"
        }
    }

    var authorizeURL: URL {
        switch self {
        case .dropbox: URL(string: "https://www.dropbox.com/oauth2/authorize")!
        case .googleDrive: URL(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        }
    }

    /// health-core's DROPBOX_TOKEN_URL and GOOGLE_TOKEN_URL.
    var tokenURL: URL {
        switch self {
        case .dropbox: URL(string: "https://api.dropboxapi.com/oauth2/token")!
        case .googleDrive: URL(string: "https://oauth2.googleapis.com/token")!
        }
    }

    /// The Drive scope, `drive.file` only: the app sees the files it made and nothing else.
    static let driveFileScope = "https://www.googleapis.com/auth/drive.file"

    /// What the authorize URL asks for beyond the PKCE basics. Dropbox's offline
    /// access gives a refresh token; Google gives one to an iOS client by default.
    var extraAuthorizeParameters: [String: String] {
        switch self {
        case .dropbox: ["token_access_type": "offline"]
        case .googleDrive: ["scope": Self.driveFileScope]
        }
    }
}
