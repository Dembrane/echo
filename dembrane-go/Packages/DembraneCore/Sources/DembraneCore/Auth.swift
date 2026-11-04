import Foundation

/// A signed-in dembrane session: the bearer token sign-in returned, sent as
/// `Authorization: Bearer` on every call. Persisted via `SessionStore`.
public struct DembraneSession: Codable, Sendable, Equatable {
    public var accessToken: String
    public var expiresAt: Date?

    public init(accessToken: String, expiresAt: Date? = nil) {
        self.accessToken = accessToken
        self.expiresAt = expiresAt
    }
}

public enum AuthError: Error, Sendable, Equatable {
    case invalidCredentials
    case otpRequired          // 2FA enabled — a valid authenticator code is needed (or was wrong)
    case invalidCode          // the emailed sign-in code was wrong or has expired
    case emailNotVerified
    /// The account is signed in on two other devices, its limit. The sign-in is
    /// kept waiting until `replaceOtherDevice(_:)` signs one of them out, or
    /// `cancelHeldSignIn()`.
    case signedInElsewhere(devices: [OtherDevice])
    case rateLimited(retryAfter: Int?)
    case accountInactive
    case server(status: Int)
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

/// A random id this install keeps and sends with every sign-in call, so the
/// server can tell this phone signing in again from a second device. It holds
/// nothing about the phone, and reinstalling the app makes a new one.
public enum DeviceIdentity {
    public static let defaultsKey = "dembrane.go.deviceId"

    public static func current(defaults: UserDefaults = .standard) -> String {
        if let existing = defaults.string(forKey: defaultsKey), !existing.isEmpty { return existing }
        let fresh = UUID().uuidString.lowercased()
        defaults.set(fresh, forKey: defaultsKey)
        return fresh
    }
}

/// Sign-in against the dembrane API: password, authenticator code, emailed
/// code, and the two-device rule. The token it stores is what every other
/// client sends as `Authorization: Bearer`.
public actor AuthService {
    private let endpoints: DembraneEndpoints
    private let session: URLSession
    private let sessionManager: SessionManager
    private let deviceId: String
    /// A sign-in the server accepted but keeps waiting because the account is
    /// signed in on two other devices. It signs nobody in until one is signed out.
    private var held: DembraneSession?

    /// The server refuses a sign-in call that carries cookies without a browser
    /// origin, so sign-in runs on a session that neither stores nor sends them.
    public static let cookielessSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        return URLSession(configuration: config)
    }()

    public init(env: AppEnvironment,
                session: URLSession = AuthService.cookielessSession,
                sessionManager: SessionManager,
                deviceId: String = DeviceIdentity.current()) {
        self.endpoints = DembraneEndpoints(env: env)
        self.session = session
        self.sessionManager = sessionManager
        self.deviceId = deviceId
    }

    /// Email and password. With two-factor on, a call without `otp` throws
    /// `otpRequired`; the next call carries the authenticator code.
    public func login(email: String, password: String, otp: String? = nil) async throws -> DembraneSession {
        var reply = try await post(endpoints.signInEmail(), json: ["email": email, "password": password])
        if reply.body.twoFactorRedirect == true {
            guard let otp, !otp.isEmpty else { throw AuthError.otpRequired }
            guard let cookie = reply.twoFactorCookie else { throw AuthError.badResponse }
            do {
                reply = try await post(endpoints.verifyTOTP(), json: ["code": otp], cookie: cookie)
            } catch AuthError.invalidCredentials {
                throw AuthError.otpRequired
            }
        }
        return try await finishSignIn(reply)
    }

    /// Emails a six-digit sign-in code. People who never set a password (they
    /// were invited, or use Google on the web) sign in this way. The answer is
    /// the same whether or not the address has an account.
    public func sendSignInCode(email: String) async throws {
        _ = try await post(endpoints.sendSignInCode(), json: ["email": email, "type": "sign-in"])
    }

    public func login(email: String, code: String) async throws -> DembraneSession {
        let reply: Reply
        do {
            reply = try await post(endpoints.signInEmailCode(), json: ["email": email, "otp": code])
        } catch AuthError.invalidCredentials {
            throw AuthError.invalidCode
        }
        return try await finishSignIn(reply)
    }

    /// Signs out the device the person chose from `signedInElsewhere` and
    /// completes the sign-in it left waiting. When the devices changed in the
    /// meantime, a freed place completes the sign-in, and otherwise the fresh
    /// list comes back as `signedInElsewhere`.
    public func replaceOtherDevice(_ id: OtherDevice.ID) async throws -> DembraneSession {
        guard let held else { throw AuthError.badResponse }
        do {
            _ = try await post(endpoints.replaceOtherDevice(), json: ["sessionId": id], token: held.accessToken)
        } catch AuthError.server(status: 409) {
            return try await finishSignIn(token: held.accessToken)
        }
        try await sessionManager.set(held)
        self.held = nil
        return held
    }

    /// Drops a waiting sign-in the person chose not to complete.
    public func cancelHeldSignIn() async {
        guard let held else { return }
        self.held = nil
        _ = try? await post(endpoints.signOut(), json: [:], token: held.accessToken)
    }

    /// Asks the server whether the stored session still signs someone in. The
    /// API client calls this on a 401: true means retry, false means the session
    /// is gone (expired, signed out from another device, account closed).
    ///
    /// There is no token to renew: the server extends a session each day it is
    /// used and ends it after seven days without use.
    @discardableResult
    public func refresh() async throws -> Bool {
        guard let current = await sessionManager.current() else { return false }
        var req = request(endpoints.getSession(), method: "GET", token: current.accessToken)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, resp) = try await session.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200,
              let found = try? DembraneJSON.decoder().decode(SessionEnvelope?.self, from: data),
              found.session.held != true else { return false }
        if found.session.expiresAt != current.expiresAt {
            try await sessionManager.set(DembraneSession(accessToken: current.accessToken,
                                                         expiresAt: found.session.expiresAt))
        }
        return true
    }

    /// Ends the session on the server, then forgets it here. The local sign-out
    /// happens even offline; the server session then runs out on its own.
    public func logout() async {
        if let token = await sessionManager.accessToken() {
            _ = try? await post(endpoints.signOut(), json: [:], token: token)
        }
        try? await sessionManager.clear()
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
        var req = request(endpoints.register(), method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (_, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if code == 429 { throw AuthError.rateLimited(retryAfter: Self.retryAfter(resp)) }
        guard (200..<300).contains(code) else { throw AuthError.server(status: code) }
    }

    // MARK: - helpers

    private struct Reply {
        let body: SignInBody
        let headerToken: String?
        let twoFactorCookie: String?
    }

    /// Stores the session a sign-in returned, unless the server is holding it
    /// because the account is signed in on two other devices.
    private func finishSignIn(_ reply: Reply) async throws -> DembraneSession {
        guard let token = reply.headerToken ?? reply.body.token, !token.isEmpty else {
            throw AuthError.badResponse
        }
        return try await finishSignIn(token: token)
    }

    private func finishSignIn(token: String) async throws -> DembraneSession {
        let new = DembraneSession(accessToken: token)
        if let hold = await hold(token: token) {
            held = new
            throw AuthError.signedInElsewhere(devices: hold.devices)
        }
        held = nil
        try await sessionManager.set(new)
        return new
    }

    /// Non-nil when the new session is being held. A server that cannot say
    /// reads as not held, so this check alone never blocks a sign-in.
    private func hold(token: String) async -> OtherSessions? {
        let req = request(endpoints.otherSessions(), method: "GET", token: token)
        guard let (data, resp) = try? await session.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let state = try? DembraneJSON.decoder().decode(OtherSessions.self, from: data),
              state.held else { return nil }
        return state
    }

    private func request(_ url: URL, method: String, token: String? = nil) -> URLRequest {
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 20
        req.httpShouldHandleCookies = false
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        req.setValue(deviceId, forHTTPHeaderField: "x-device-id")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return req
    }

    private func post(_ url: URL, json: [String: String], token: String? = nil,
                      cookie: String? = nil) async throws -> Reply {
        var req = request(url, method: "POST", token: token)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let cookie {
            // The authenticator step is tied to the password step by a short-lived
            // cookie, and the server takes a cookie only together with the
            // dashboard's origin.
            req.setValue(cookie, forHTTPHeaderField: "Cookie")
            req.setValue(Self.origin(of: endpoints.env.dashboardBaseURL), forHTTPHeaderField: "Origin")
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: json)
        let (data, resp) = try await session.data(for: req)
        let http = resp as? HTTPURLResponse
        let code = http?.statusCode ?? -1
        guard (200..<300).contains(code) else {
            throw Self.error(status: code, data: data, response: resp)
        }
        let body = (try? DembraneJSON.decoder().decode(SignInBody.self, from: data)) ?? SignInBody()
        return Reply(body: body,
                     headerToken: http?.value(forHTTPHeaderField: "set-auth-token"),
                     twoFactorCookie: http.flatMap { Self.twoFactorCookie(in: $0, for: url) })
    }

    private static func error(status: Int, data: Data, response: URLResponse) -> AuthError {
        if status == 429 { return .rateLimited(retryAfter: retryAfter(response)) }
        let code = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.code
        switch code {
        case "INVALID_EMAIL_OR_PASSWORD": return .invalidCredentials
        case "EMAIL_NOT_VERIFIED": return .emailNotVerified
        case "INVALID_CODE", "INVALID_TWO_FACTOR_CODE": return .otpRequired
        case "INVALID_OTP", "OTP_EXPIRED", "TOO_MANY_ATTEMPTS": return .invalidCode
        default: break
        }
        if status == 401 { return .invalidCredentials }
        // A closed or suspended account is refused a session with a 403.
        if status == 403 { return .accountInactive }
        return .server(status: status)
    }

    private static func retryAfter(_ response: URLResponse) -> Int? {
        guard let http = response as? HTTPURLResponse else { return nil }
        let raw = http.value(forHTTPHeaderField: "X-Retry-After") ?? http.value(forHTTPHeaderField: "Retry-After")
        return raw.flatMap { Int($0) }
    }

    /// `name=value` of the cookie that carries a password sign-in over to the
    /// authenticator step. Its name ends in `two_factor` behind a prefix that
    /// differs between https and local servers.
    static func twoFactorCookie(in response: HTTPURLResponse, for url: URL) -> String? {
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { out, pair in
            if let k = pair.key as? String, let v = pair.value as? String { out[k] = v }
        }
        return HTTPCookie.cookies(withResponseHeaderFields: headers, for: url)
            .first { $0.name.hasSuffix("two_factor") && !$0.value.isEmpty }
            .map { "\($0.name)=\($0.value)" }
    }

    /// The server keeps the user agent a session signed in with, and names the
    /// device by it when someone has to choose one to sign out. This one reads as
    /// "iPhone" there, where the system's own reads as an unknown device.
    static let userAgent = "dembrane Go (iPhone)"

    static func origin(of url: URL) -> String {
        var out = "\(url.scheme ?? "https")://\(url.host ?? "")"
        if let port = url.port { out += ":\(port)" }
        return out
    }
}

struct SignInBody: Decodable {
    var token: String?
    var twoFactorRedirect: Bool?
}

/// A device the account is signed in on, as the server lists it while a sign-in
/// is held: coarse names read from its user agent, and when it was last used.
public struct OtherDevice: Decodable, Sendable, Equatable, Identifiable {
    /// One of the device's sessions. Signing it out signs out the whole device.
    public let id: String
    public let browser: String?
    public let platform: String?
    public let lastActiveAt: Date?

    /// "Chrome on macOS", whichever of the two the server knew, or "Unknown device".
    public var name: String {
        switch (browser, platform) {
        case let (browser?, platform?): return "\(browser) on \(platform)"
        case let (browser?, nil): return browser
        case let (nil, platform?): return platform
        case (nil, nil): return "Unknown device"
        }
    }
}

struct OtherSessions: Decodable {
    let held: Bool
    let devices: [OtherDevice]

    private enum CodingKeys: String, CodingKey { case held, devices }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        held = try c.decode(Bool.self, forKey: .held)
        devices = try c.decodeIfPresent([OtherDevice].self, forKey: .devices) ?? []
    }
}

struct SessionEnvelope: Decodable {
    struct Session: Decodable {
        let expiresAt: Date?
        let held: Bool?
    }
    let session: Session
}

private struct ErrorBody: Decodable { let code: String? }
