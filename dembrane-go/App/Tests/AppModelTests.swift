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
        XCTAssertEqual(model.defaultProjectName, "go")
        XCTAssertEqual(model.phase, .loading)
    }

    func testToggleRecording() {
        let model = AppModel.makeMock()
        model.toggleRecording()
        XCTAssertTrue(model.isRecording)
        model.toggleRecording()
        XCTAssertFalse(model.isRecording)
    }

    func testLoadDataPopulatesFromMock() async {
        let model = AppModel.makeMock()
        await model.loadData()
        XCTAssertEqual(model.me?.email, "you@dembrane.com")
        XCTAssertEqual(model.defaultWorkspace?.name, "your workspace")
        XCTAssertEqual(model.defaultProject?.name, "go")
        XCTAssertFalse(model.conversations.isEmpty)
    }

    func testSignOutResetsState() async {
        let model = AppModel.makeMock()
        await model.loadData()
        await model.signOut()
        XCTAssertEqual(model.phase, .signedOut)
        XCTAssertNil(model.me)
        XCTAssertTrue(model.conversations.isEmpty)
    }
}
