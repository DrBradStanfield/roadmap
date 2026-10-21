import Foundation
import Security

/// A Keychain copy of the update state's two watermarks, `highWater` (the highest
/// version ever accepted) and `floor` (the highest `minVersion` seen) (US-25 AC18,
/// review N5). state.json can be lost or corrupted; these cannot be lowered: each is
/// only ever raised. This device only, readable after first unlock, so a backup or
/// another phone never carries them.
struct EngineWatermark: Sendable {
    let service: String
    static let live = EngineWatermark(service: "com.drbrad.healthroadmap.engine-watermark")

    /// Both marks; 0 for one never set or not readable now.
    func read() -> (highWater: Int, floor: Int) {
        (value("highWater"), value("floor"))
    }

    /// Raises each mark to the given value if it is higher; never lowers one.
    func raise(highWater: Int, floor: Int) {
        set("highWater", highWater)
        set("floor", floor)
    }

    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    private func value(_ account: String) -> Int {
        var query = query(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return 0 }
        return Int(String(decoding: data, as: UTF8.self)) ?? 0
    }

    private func set(_ account: String, _ number: Int) {
        guard number > value(account) else { return }
        let data = Data(String(number).utf8)
        let update = [kSecValueData as String: data] as CFDictionary
        if SecItemUpdate(query(account) as CFDictionary, update) == errSecItemNotFound {
            var add = query(account)
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }
}
