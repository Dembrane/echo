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
}
