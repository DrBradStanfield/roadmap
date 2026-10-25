import Foundation
import Security

/// A provider's OAuth tokens, as kept in the Keychain.
struct OAuthTokens: Codable, Equatable, Sendable {
    var accessToken: String
    var refreshToken: String
    var expiresAt: Date
}

/// The cloud tokens, in the Keychain (US-25 AC11, architecture.md D5): readable
/// once the phone has been unlocked after a restart, so a sync can run in the
/// background, and never copied to a backup or another phone
/// (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`). The web keeps the same
/// tokens in localStorage (widget-src/src/storage/dropbox.ts).
struct TokenStore: Sendable {
    /// The Keychain service; tests use their own.
    let service: String

    init(service: String = "com.drstanfield.healthroadmap.oauth") {
        self.service = service
    }

    func save(_ tokens: OAuthTokens, for provider: CloudProvider) throws {
        let data = try JSONEncoder().encode(tokens)
        let query = baseQuery(provider)
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(update) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    func load(_ provider: CloudProvider) -> OAuthTokens? {
        var query = baseQuery(provider)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(OAuthTokens.self, from: data)
    }

    /// The item's accessibility class, for the test that pins it.
    func accessibility(_ provider: CloudProvider) -> String? {
        var query = baseQuery(provider)
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let attributes = item as? [String: Any] else { return nil }
        return attributes[kSecAttrAccessible as String] as? String
    }

    func delete(_ provider: CloudProvider) {
        SecItemDelete(baseQuery(provider) as CFDictionary)
    }

    private func baseQuery(_ provider: CloudProvider) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider.rawValue,
        ]
    }
}

struct KeychainError: LocalizedError {
    let status: OSStatus
    var errorDescription: String? { "The Keychain refused to keep the sign-in (\(status))." }
}
