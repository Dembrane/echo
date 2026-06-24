import Foundation

/// A logged-in dembrane session (Directus tokens). Persisted via `SessionStore`.
public struct DembraneSession: Codable, Sendable, Equatable {
    public var accessToken: String
    public var refreshToken: String
    public var expiresAt: Date?

    public init(accessToken: String, refreshToken: String, expiresAt: Date? = nil) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
    }
}

public enum AuthError: Error, Sendable, Equatable {
    case invalidCredentials
    case server(status: Int)
    case noRefreshToken
    case badResponse
}

/// Owns the current session and persists it through a `SessionStore`. Actor so
/// the API client and UI can read the token from any context safely.
public actor SessionManager {
    private let store: SessionStore
    private var cached: DembraneSession?

    public init(store: SessionStore) {
        self.store = store
        if let raw = store.load(), let data = raw.data(using: .utf8),
           let session = try? JSONDecoder().decode(DembraneSession.self, from: data) {
            cached = session
        }
    }

    public func current() -> DembraneSession? { cached }
    public func accessToken() -> String? { cached?.accessToken }
    public func refreshToken() -> String? { cached?.refreshToken }
    public func isAuthenticated() -> Bool { cached != nil }

    public func set(_ session: DembraneSession) throws {
        cached = session
        let data = try JSONEncoder().encode(session)
        try store.save(token: String(decoding: data, as: UTF8.self))
    }

    public func clear() throws {
        cached = nil
        try store.clear()
    }
}

/// Email/password auth against Directus (echo has no login proxy). Returns the
/// Directus access token used as `Authorization: Bearer` on echo BFF calls.
public actor AuthService {
    private let endpoints: DembraneEndpoints
    private let session: URLSession
    private let sessionManager: SessionManager

    public init(env: AppEnvironment, session: URLSession = .shared, sessionManager: SessionManager) {
        self.endpoints = DembraneEndpoints(env: env)
        self.session = session
        self.sessionManager = sessionManager
    }

    public func login(email: String, password: String) async throws -> DembraneSession {
        let body = ["email": email, "password": password]
        let auth = try await post(endpoints.directusLogin(), json: body)
        let newSession = makeSession(from: auth)
        try await sessionManager.set(newSession)
        return newSession
    }

    /// Register a new account (info-neutral on the backend — always succeeds
    /// with 2xx). A verification email is sent; the user verifies via the web,
    /// then signs in.
    public func register(email: String, password: String, firstName: String,
                         lastName: String?, verificationURL: String) async throws {
        var body: [String: String] = [
            "email": email, "password": password,
            "first_name": firstName, "verification_url": verificationURL,
        ]
        if let lastName, !lastName.isEmpty { body["last_name"] = lastName }
        var req = URLRequest(url: endpoints.register())
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (_, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw AuthError.server(status: code) }
    }

    /// Refresh the access token. Returns true on success (used by the API
    /// client's 401 retry).
    @discardableResult
    public func refresh() async throws -> Bool {
        guard let refreshToken = await sessionManager.refreshToken() else {
            throw AuthError.noRefreshToken
        }
        let body: [String: String] = ["refresh_token": refreshToken, "mode": "json"]
        let auth = try await post(endpoints.directusRefresh(), json: body)
        try await sessionManager.set(makeSession(from: auth))
        return true
    }

    public func logout() async {
        try? await sessionManager.clear()
    }

    // MARK: - helpers

    private func makeSession(from auth: DirectusAuthData) -> DembraneSession {
        // Directus `expires` is the access-token TTL in milliseconds.
        let expiresAt = auth.expires.map { Date().addingTimeInterval(Double($0) / 1000.0) }
        return DembraneSession(accessToken: auth.accessToken,
                               refreshToken: auth.refreshToken,
                               expiresAt: expiresAt)
    }

    private func post(_ url: URL, json: [String: String]) async throws -> DirectusAuthData {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = try JSONSerialization.data(withJSONObject: json)
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if code == 401 { throw AuthError.invalidCredentials }
        guard (200..<300).contains(code) else { throw AuthError.server(status: code) }
        guard let decoded = try? DembraneJSON.decoder().decode(DirectusAuthResponse.self, from: data) else {
            throw AuthError.badResponse
        }
        return decoded.data
    }
}

struct DirectusAuthResponse: Decodable { let data: DirectusAuthData }
struct DirectusAuthData: Decodable {
    let accessToken: String
    let refreshToken: String
    let expires: Int?
}
