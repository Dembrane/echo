import XCTest
@testable import DembraneCore

final class AuthEndpointsTests: XCTestCase {
    let e = DembraneEndpoints(env: .echoNext)

    func testDirectusLoginIsOnDirectusHost() {
        XCTAssertEqual(
            e.directusLogin().absoluteString,
            "https://directus.echo-next.dembrane.com/auth/login")
    }

    func testDirectusRefresh() {
        XCTAssertEqual(
            e.directusRefresh().absoluteString,
            "https://directus.echo-next.dembrane.com/auth/refresh")
    }
}
