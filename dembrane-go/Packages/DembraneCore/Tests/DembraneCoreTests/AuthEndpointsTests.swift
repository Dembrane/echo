import XCTest
@testable import DembraneCore

final class AuthEndpointsTests: XCTestCase {
    let e = DembraneEndpoints(env: .staging)
    private let base = "https://api.staging.dembrane.com/api"

    func testSignInLivesOnTheAPIHost() {
        XCTAssertEqual(e.signInEmail().absoluteString, "\(base)/auth/sign-in/email")
        XCTAssertEqual(e.verifyTOTP().absoluteString, "\(base)/auth/two-factor/verify-totp")
        XCTAssertEqual(e.signInEmailCode().absoluteString, "\(base)/auth/sign-in/email-otp")
        XCTAssertEqual(e.sendSignInCode().absoluteString, "\(base)/auth/email-otp/send-verification-otp")
    }

    func testSessionURLs() {
        XCTAssertEqual(e.getSession().absoluteString, "\(base)/auth/get-session")
        XCTAssertEqual(e.signOut().absoluteString, "\(base)/auth/sign-out")
        XCTAssertEqual(e.otherSessions().absoluteString, "\(base)/auth/other-sessions")
        XCTAssertEqual(e.replaceOtherSessions().absoluteString, "\(base)/auth/other-sessions/replace")
    }

    func testAssetIsServedByTheAPI() {
        XCTAssertEqual(e.asset(id: "f1").absoluteString, "\(base)/assets/f1")
    }
}
