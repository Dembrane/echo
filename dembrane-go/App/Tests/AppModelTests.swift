import XCTest
@testable import DembraneGo
import DembraneCore

@MainActor
final class AppModelTests: XCTestCase {
    func testDefaults() {
        let model = AppModel.makeMock()
        XCTAssertEqual(model.environment, .echoNext)
        XCTAssertFalse(model.isRecording)
        XCTAssertFalse(model.trainingOptIn)
        XCTAssertEqual(model.defaultProjectName, "Go Recordings")
        XCTAssertEqual(model.phase, .loading)
    }

    func testLoadDataPopulatesFromMock() async {
        let model = AppModel.makeMock()
        await model.loadData()
        XCTAssertEqual(model.me?.email, "you@dembrane.com")
        XCTAssertEqual(model.selectedProject?.name, "Go Recordings")
        XCTAssertFalse(model.allProjects.isEmpty)
        XCTAssertFalse(model.conversations.isEmpty)
    }

    func testSignOutResetsState() async {
        let model = AppModel.makeMock()
        await model.loadData()
        await model.signOut()
        XCTAssertEqual(model.phase, .signedOut)
        XCTAssertNil(model.me)
        XCTAssertNil(model.selectedProject)
        XCTAssertTrue(model.conversations.isEmpty)
    }
}
