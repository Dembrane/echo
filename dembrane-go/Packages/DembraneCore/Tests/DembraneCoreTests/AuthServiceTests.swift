import XCTest
@testable import DembraneCore

final class AuthServiceTests: XCTestCase {
    private let base = "https://api.staging.dembrane.com/api/auth"

    override func tearDown() {
        MockURLProtocol.handler = nil
        super.tearDown()
    }

    private func makeAuth(_ manager: SessionManager = SessionManager(store: InMemorySessionStore())) -> AuthService {
        AuthService(env: .staging, session: MockURLProtocol.makeSession(),
                    sessionManager: manager, deviceId: "device-1234")
    }

    private static func reply(_ req: URLRequest, _ status: Int = 200, _ json: String,
                              headers: [String: String] = [:]) -> (HTTPURLResponse, Data) {
        (HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: headers)!,
         Data(json.utf8))
    }

    /// Requests seen by the mock, in order.
    private final class Log: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [URLRequest] = []
        func add(_ r: URLRequest) { lock.withLock { items.append(r) } }
        var all: [URLRequest] { lock.withLock { items } }
        func paths() -> [String] { all.map { $0.url!.path } }
    }

    func testLoginStoresTheBearerToken() async throws {
        let log = Log()
        MockURLProtocol.handler = { req in
            log.add(req)
            if req.url!.path.hasSuffix("/other-sessions") {
                return Self.reply(req, 200, #"{"held":false,"since":null}"#)
            }
            return Self.reply(req, 200, #"{"redirect":false,"token":"raw","user":{"id":"u1"}}"#,
                              headers: ["set-auth-token": "raw.signature"])
        }
        let manager = SessionManager(store: InMemorySessionStore())
        let session = try await makeAuth(manager).login(email: "a@b.com", password: "pw")

        XCTAssertEqual(session.accessToken, "raw.signature")
        XCTAssertEqual(log.all.first?.url?.absoluteString, "\(base)/sign-in/email")
        XCTAssertEqual(log.all.first?.value(forHTTPHeaderField: "x-device-id"), "device-1234")
        XCTAssertNil(log.all.first?.value(forHTTPHeaderField: "Cookie"))
        XCTAssertEqual(log.all.last?.value(forHTTPHeaderField: "Authorization"), "Bearer raw.signature")
        let stored = await manager.accessToken()
        XCTAssertEqual(stored, "raw.signature")
    }

    func testLoginFallsBackToTheTokenInTheBody() async throws {
        MockURLProtocol.handler = { req in
            if req.url!.path.hasSuffix("/other-sessions") {
                return Self.reply(req, 200, #"{"held":false,"since":null}"#)
            }
            return Self.reply(req, 200, #"{"redirect":false,"token":"raw"}"#)
        }
        let session = try await makeAuth().login(email: "a@b.com", password: "pw")
        XCTAssertEqual(session.accessToken, "raw")
    }

    func testLoginBadCredentialsThrows() async {
        MockURLProtocol.handler = { req in
            Self.reply(req, 401, #"{"message":"Invalid email or password","code":"INVALID_EMAIL_OR_PASSWORD"}"#)
        }
        do {
            _ = try await makeAuth().login(email: "a@b.com", password: "bad")
            XCTFail("expected invalidCredentials")
        } catch {
            XCTAssertEqual(error as? AuthError, .invalidCredentials)
        }
    }

    func testUnverifiedEmailAndTooManyTriesAreToldApart() async {
        MockURLProtocol.handler = { req in
            Self.reply(req, 403, #"{"message":"Email not verified","code":"EMAIL_NOT_VERIFIED"}"#)
        }
        do { _ = try await makeAuth().login(email: "a@b.com", password: "pw"); XCTFail("expected a throw") }
        catch { XCTAssertEqual(error as? AuthError, .emailNotVerified) }

        MockURLProtocol.handler = { req in
            Self.reply(req, 429, #"{"message":"Too many requests. Please try again later."}"#,
                       headers: ["X-Retry-After": "7"])
        }
        do { _ = try await makeAuth().login(email: "a@b.com", password: "pw"); XCTFail("expected a throw") }
        catch { XCTAssertEqual(error as? AuthError, .rateLimited(retryAfter: 7)) }
    }

    func testTwoFactorAsksForACodeThenVerifiesIt() async throws {
        let log = Log()
        MockURLProtocol.handler = { req in
            log.add(req)
            switch req.url!.path {
            case let p where p.hasSuffix("/sign-in/email"):
                return Self.reply(req, 200, #"{"twoFactorRedirect":true,"twoFactorMethods":["totp"]}"#,
                                  headers: ["Set-Cookie": "__Secure-dembrane.two_factor=tf.sig; Max-Age=600; Path=/; HttpOnly; Secure"])
            case let p where p.hasSuffix("/two-factor/verify-totp"):
                return Self.reply(req, 200, #"{"token":"raw"}"#, headers: ["set-auth-token": "raw.signature"])
            default:
                return Self.reply(req, 200, #"{"held":false,"since":null}"#)
            }
        }
        let auth = makeAuth()
        do {
            _ = try await auth.login(email: "a@b.com", password: "pw")
            XCTFail("expected otpRequired")
        } catch {
            XCTAssertEqual(error as? AuthError, .otpRequired)
        }

        let session = try await auth.login(email: "a@b.com", password: "pw", otp: "123456")
        XCTAssertEqual(session.accessToken, "raw.signature")
        let verify = log.all.first { $0.url!.path.hasSuffix("/two-factor/verify-totp") }
        XCTAssertEqual(verify?.value(forHTTPHeaderField: "Cookie"), "__Secure-dembrane.two_factor=tf.sig")
        XCTAssertEqual(verify?.value(forHTTPHeaderField: "Origin"), "https://dashboard.staging.dembrane.com")
    }

    func testWrongAuthenticatorCodeAsksAgain() async {
        MockURLProtocol.handler = { req in
            if req.url!.path.hasSuffix("/sign-in/email") {
                return Self.reply(req, 200, #"{"twoFactorRedirect":true}"#,
                                  headers: ["Set-Cookie": "dembrane.two_factor=tf; Path=/"])
            }
            return Self.reply(req, 401, #"{"message":"Invalid code","code":"INVALID_CODE"}"#)
        }
        do {
            _ = try await makeAuth().login(email: "a@b.com", password: "pw", otp: "000000")
            XCTFail("expected otpRequired")
        } catch {
            XCTAssertEqual(error as? AuthError, .otpRequired)
        }
    }

    func testSignInOnASecondDeviceWaitsUntilReplaced() async throws {
        let log = Log()
        MockURLProtocol.handler = { req in
            log.add(req)
            switch req.url!.path {
            case let p where p.hasSuffix("/other-sessions"):
                return Self.reply(req, 200, #"{"held":true,"since":"2026-10-09T07:03:48.482Z"}"#)
            case let p where p.hasSuffix("/other-sessions/replace"):
                return Self.reply(req, 200, #"{"replaced":1}"#)
            default:
                return Self.reply(req, 200, #"{"token":"raw"}"#, headers: ["set-auth-token": "raw.signature"])
            }
        }
        let manager = SessionManager(store: InMemorySessionStore())
        let auth = makeAuth(manager)
        do {
            _ = try await auth.login(email: "a@b.com", password: "pw")
            XCTFail("expected signedInElsewhere")
        } catch AuthError.signedInElsewhere(let since) {
            XCTAssertNotNil(since)
        } catch {
            XCTFail("unexpected \(error)")
        }
        let before = await manager.isAuthenticated()
        XCTAssertFalse(before, "a waiting sign-in signs nobody in")

        let session = try await auth.replaceOtherSessions()
        XCTAssertEqual(session.accessToken, "raw.signature")
        XCTAssertEqual(log.all.last?.url?.absoluteString, "\(base)/other-sessions/replace")
        XCTAssertEqual(log.all.last?.value(forHTTPHeaderField: "Authorization"), "Bearer raw.signature")
        let after = await manager.isAuthenticated()
        XCTAssertTrue(after)
    }

    func testCancellingAWaitingSignInEndsIt() async {
        let log = Log()
        MockURLProtocol.handler = { req in
            log.add(req)
            if req.url!.path.hasSuffix("/other-sessions") {
                return Self.reply(req, 200, #"{"held":true,"since":null}"#)
            }
            return Self.reply(req, 200, #"{"token":"raw"}"#)
        }
        let manager = SessionManager(store: InMemorySessionStore())
        let auth = makeAuth(manager)
        _ = try? await auth.login(email: "a@b.com", password: "pw")
        await auth.cancelHeldSignIn()

        XCTAssertEqual(log.paths().last, "/api/auth/sign-out")
        let authed = await manager.isAuthenticated()
        XCTAssertFalse(authed)
    }

    func testEmailedCodeSignIn() async throws {
        let log = Log()
        MockURLProtocol.handler = { req in
            log.add(req)
            switch req.url!.path {
            case let p where p.hasSuffix("/email-otp/send-verification-otp"):
                return Self.reply(req, 200, #"{"success":true}"#)
            case let p where p.hasSuffix("/sign-in/email-otp"):
                return Self.reply(req, 200, #"{"token":"raw"}"#)
            default:
                return Self.reply(req, 200, #"{"held":false,"since":null}"#)
            }
        }
        let auth = makeAuth()
        try await auth.sendSignInCode(email: "a@b.com")
        let session = try await auth.login(email: "a@b.com", code: "123456")
        XCTAssertEqual(session.accessToken, "raw")
        XCTAssertEqual(log.paths().prefix(2), ["/api/auth/email-otp/send-verification-otp", "/api/auth/sign-in/email-otp"])
    }

    func testWrongEmailedCodeThrows() async {
        MockURLProtocol.handler = { req in
            Self.reply(req, 400, #"{"message":"Invalid OTP","code":"INVALID_OTP"}"#)
        }
        do {
            _ = try await makeAuth().login(email: "a@b.com", code: "000000")
            XCTFail("expected invalidCode")
        } catch {
            XCTAssertEqual(error as? AuthError, .invalidCode)
        }
    }

    func testRefreshKeepsALiveSessionAndRecordsItsExpiry() async throws {
        MockURLProtocol.handler = { req in
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer T")
            return Self.reply(req, 200, #"{"session":{"expiresAt":"2026-10-16T07:03:48.482Z","held":false},"user":{"id":"u1"}}"#)
        }
        let manager = SessionManager(store: InMemorySessionStore())
        try await manager.set(DembraneSession(accessToken: "T"))
        let alive = try await makeAuth(manager).refresh()
        XCTAssertTrue(alive)
        let current = await manager.current()
        XCTAssertEqual(current?.accessToken, "T")
        XCTAssertNotNil(current?.expiresAt)
    }

    func testRefreshReportsAnEndedSession() async throws {
        MockURLProtocol.handler = { req in Self.reply(req, 200, "null") }
        let manager = SessionManager(store: InMemorySessionStore())
        try await manager.set(DembraneSession(accessToken: "T"))
        let alive = try await makeAuth(manager).refresh()
        XCTAssertFalse(alive)
    }

    func testRefreshWithoutASessionIsFalse() async throws {
        let alive = try await makeAuth().refresh()
        XCTAssertFalse(alive)
    }

    func testLogoutEndsTheServerSessionAndClearsTheStore() async throws {
        let log = Log()
        MockURLProtocol.handler = { req in
            log.add(req)
            return Self.reply(req, 200, #"{"success":true}"#)
        }
        let manager = SessionManager(store: InMemorySessionStore())
        try await manager.set(DembraneSession(accessToken: "T"))
        await makeAuth(manager).logout()

        XCTAssertEqual(log.all.first?.url?.absoluteString, "\(base)/sign-out")
        XCTAssertEqual(log.all.first?.value(forHTTPHeaderField: "Authorization"), "Bearer T")
        XCTAssertNil(log.all.first?.value(forHTTPHeaderField: "Cookie"))
        let authed = await manager.isAuthenticated()
        XCTAssertFalse(authed)
    }

    func testLogoutClearsTheStoreWhenTheServerIsUnreachable() async throws {
        MockURLProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
        let manager = SessionManager(store: InMemorySessionStore())
        try await manager.set(DembraneSession(accessToken: "T"))
        await makeAuth(manager).logout()
        let authed = await manager.isAuthenticated()
        XCTAssertFalse(authed)
    }

    func testASessionStoredByAnOlderBuildStillLoads() {
        let old = #"{"accessToken":"AT","refreshToken":"RT"}"#
        let store = InMemorySessionStore(token: old)
        let exp = expectation(description: "loaded")
        Task {
            let token = await SessionManager(store: store).accessToken()
            XCTAssertEqual(token, "AT")
            exp.fulfill()
        }
        wait(for: [exp], timeout: 2)
    }

    func testDeviceIdentityIsStable() {
        let defaults = UserDefaults(suiteName: "auth-tests-\(UUID().uuidString)")!
        let first = DeviceIdentity.current(defaults: defaults)
        XCTAssertEqual(DeviceIdentity.current(defaults: defaults), first)
        XCTAssertNotNil(first.range(of: "^[A-Za-z0-9-]{8,64}$", options: .regularExpression))
    }
}
