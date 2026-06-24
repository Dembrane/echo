import XCTest
@testable import DembraneCore

final class EndpointsTests: XCTestCase {
    let e = DembraneEndpoints(env: .echoNext)
    private let base = "https://api.echo-next.dembrane.com/api"

    func testMe() {
        XCTAssertEqual(e.me().absoluteString, "\(base)/v2/me")
    }

    func testWorkspaces() {
        XCTAssertEqual(e.workspaces().absoluteString, "\(base)/v2/workspaces")
    }

    func testProjects() {
        XCTAssertEqual(
            e.projects(workspaceId: "W1").absoluteString,
            "\(base)/v2/workspaces/W1/projects")
    }

    func testConversationsCarriesProjectQuery() {
        XCTAssertEqual(
            e.conversations(projectId: "P1").absoluteString,
            "\(base)/v2/bff/conversations?project_id=P1")
    }

    func testInitiateConversation() {
        XCTAssertEqual(
            e.initiateConversation(projectId: "P1").absoluteString,
            "\(base)/participant/projects/P1/conversations/initiate")
    }

    func testFinishConversation() {
        XCTAssertEqual(
            e.finishConversation(conversationId: "C1").absoluteString,
            "\(base)/participant/conversations/C1/finish")
    }

    func testChatStream() {
        XCTAssertEqual(e.chatStream(chatId: "X").absoluteString, "\(base)/chats/X")
    }
}
