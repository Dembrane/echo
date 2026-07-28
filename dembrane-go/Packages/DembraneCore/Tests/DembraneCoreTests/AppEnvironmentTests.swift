import XCTest
@testable import DembraneCore

final class AppEnvironmentTests: XCTestCase {
    func testProductionIsDefault() {
        XCTAssertEqual(AppEnvironment.default, .production)
    }

    func testEchoNextURLs() {
        XCTAssertEqual(
            AppEnvironment.echoNext.apiBaseURL.absoluteString,
            "https://api.echo-next.dembrane.com/api")
        XCTAssertEqual(
            AppEnvironment.echoNext.directusBaseURL.host,
            "directus.echo-next.dembrane.com")
    }

    func testProductionURLs() {
        XCTAssertEqual(
            AppEnvironment.production.apiBaseURL.absoluteString,
            "https://api.dembrane.com/api")
    }
}
