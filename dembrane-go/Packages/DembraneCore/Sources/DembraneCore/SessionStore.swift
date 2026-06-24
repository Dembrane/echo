import Foundation
#if canImport(Security)
import Security
#endif

/// Where the dembrane session token lives. A protocol so the app uses the
/// Keychain (shared with extensions + watch via an access group) while tests
/// use the in-memory store.
public protocol SessionStore: Sendable {
    func save(token: String) throws
    func load() -> String?
    func clear() throws
}

public enum KeychainError: Error, Sendable, Equatable {
    case unexpectedStatus(OSStatus)
}

/// Test/preview store — no Keychain, no prompts.
public final class InMemorySessionStore: SessionStore, @unchecked Sendable {
    private var token: String?
    private let lock = NSLock()

    public init(token: String? = nil) { self.token = token }

    public func save(token: String) throws {
        lock.lock(); defer { lock.unlock() }
        self.token = token
    }
    public func load() -> String? {
        lock.lock(); defer { lock.unlock() }
        return token
    }
    public func clear() throws {
        lock.lock(); defer { lock.unlock() }
        token = nil
    }
}

/// Keychain-backed store. With `accessGroup` set, the app, Share Extension, and
/// Watch app all read the same session.
public final class KeychainSessionStore: SessionStore, @unchecked Sendable {
    private let service: String
    private let account: String
    private let accessGroup: String?

    public init(service: String = "com.dembrane.go",
                account: String = "directus-session",
                accessGroup: String? = nil) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }

    private func baseQuery() -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    public func save(token: String) throws {
        let data = Data(token.utf8)
        let query = baseQuery()
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        switch status {
        case errSecSuccess:
            let attrs = [kSecValueData as String: data]
            let s = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
            guard s == errSecSuccess else { throw KeychainError.unexpectedStatus(s) }
        case errSecItemNotFound:
            var add = query
            add[kSecValueData as String] = data
            let s = SecItemAdd(add as CFDictionary, nil)
            guard s == errSecSuccess else { throw KeychainError.unexpectedStatus(s) }
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    public func load() -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func clear() throws {
        let s = SecItemDelete(baseQuery() as CFDictionary)
        guard s == errSecSuccess || s == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(s)
        }
    }
}

/// Local store for the simulator, which has no signing identity to back the
/// Keychain entitlement. Device/TestFlight builds use the Keychain.
public final class UserDefaultsSessionStore: SessionStore, @unchecked Sendable {
    private let key: String
    private let defaults: UserDefaults

    public init(key: String = "com.dembrane.go.session", defaults: UserDefaults = .standard) {
        self.key = key
        self.defaults = defaults
    }

    public func save(token: String) throws { defaults.set(token, forKey: key) }
    public func load() -> String? { defaults.string(forKey: key) }
    public func clear() throws { defaults.removeObject(forKey: key) }
}

/// The session store for this build: Keychain on device/TestFlight, a local
/// store on the simulator (no signing identity → no Keychain entitlement).
public func makeSessionStore() -> SessionStore {
    #if targetEnvironment(simulator)
    return UserDefaultsSessionStore()
    #else
    return KeychainSessionStore()
    #endif
}
