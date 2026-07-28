import XCTest
@testable import DembraneCore

final class AuthServiceTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.handler = nil
        super.tearDown()
    }

    func testLoginParsesAndPersistsSession() async throws {
        var capturedURL: URL?
        MockURLProtocol.handler = { req in
            capturedURL = req.url
            let json = #"{"data":{"access_token":"AT","refresh_token":"RT","expires":900000}}"#
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (resp, Data(json.utf8))
        }
        let manager = SessionManager(store: InMemorySessionStore())
        let auth = AuthService(env: .echoNext, session: MockURLProtocol.makeSession(), sessionManager: manager)

        let session = try await auth.login(email: "a@b.com", password: "pw")

        XCTAssertEqual(session.accessToken, "AT")
        XCTAssertEqual(session.refreshToken, "RT")
        XCTAssertEqual(capturedURL?.absoluteString, "https://directus.echo-next.dembrane.com/auth/login")
        let token = await manager.accessToken()
        XCTAssertEqual(token, "AT")
        let authed = await manager.isAuthenticated()
        XCTAssertTrue(authed)
    }

    func testLoginBadCredentialsThrows() async {
        MockURLProtocol.handler = { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!
            return (resp, Data(#"{"errors":[{"message":"Invalid user credentials."}]}"#.utf8))
        }
        let manager = SessionManager(store: InMemorySessionStore())
        let auth = AuthService(env: .echoNext, session: MockURLProtocol.makeSession(), sessionManager: manager)

        do {
            _ = try await auth.login(email: "a@b.com", password: "bad")
            XCTFail("expected invalidCredentials")
        } catch {
            XCTAssertEqual(error as? AuthError, .invalidCredentials)
        }
    }

    func testRefreshWithoutTokenThrows() async {
        let manager = SessionManager(store: InMemorySessionStore())
        let auth = AuthService(env: .echoNext, session: MockURLProtocol.makeSession(), sessionManager: manager)
        do {
            _ = try await auth.refresh()
            XCTFail("expected noRefreshToken")
        } catch {
            XCTAssertEqual(error as? AuthError, .noRefreshToken)
        }
    }

    /// Directus rotates the refresh token on every use, so concurrent refreshes
    /// with the same token would have the losers rejected → spurious sign-out.
    /// `refresh()` must single-flight: N concurrent callers share ONE network
    /// round-trip and all succeed.
    func testConcurrentRefreshesSingleFlightToOneNetworkCall() async throws {
        let lock = NSLock()
        var hits = 0
        let firstStarted = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)

        MockURLProtocol.handler = { req in
            lock.lock(); hits += 1; let n = hits; lock.unlock()
            if n == 1 { firstStarted.signal() }
            // Hold the request open so the other refresh() calls pile up; without
            // single-flight they'd each hit the network with the same token.
            _ = release.wait(timeout: .now() + 5)
            let json = #"{"data":{"access_token":"AT2","refresh_token":"RT2","expires":900000}}"#
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (resp, Data(json.utf8))
        }

        let manager = SessionManager(store: InMemorySessionStore())
        try await manager.set(DembraneSession(accessToken: "AT", refreshToken: "RT"))
        let auth = AuthService(env: .echoNext, session: MockURLProtocol.makeSession(), sessionManager: manager)

        async let r1 = auth.refresh()
        async let r2 = auth.refresh()
        async let r3 = auth.refresh()
        async let r4 = auth.refresh()

        XCTAssertEqual(firstStarted.wait(timeout: .now() + 5), .success)
        for _ in 0..<8 { release.signal() }

        let results = try await [r1, r2, r3, r4]
        XCTAssertEqual(results, [true, true, true, true])

        let finalHits = lock.withLock { hits }
        XCTAssertEqual(finalHits, 1, "concurrent refreshes must share one network call")

        let rt = await manager.refreshToken()
        XCTAssertEqual(rt, "RT2", "session should hold the rotated refresh token")
    }
}
