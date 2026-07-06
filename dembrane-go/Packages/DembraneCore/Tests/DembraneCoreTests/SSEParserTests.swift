import XCTest
@testable import DembraneCore

final class SSEParserTests: XCTestCase {
    let p = VercelAIStreamParser()

    func testTextDelta() {
        XCTAssertEqual(p.parse(line: #"0:"Hello""#), .text("Hello"))
    }

    func testTextDeltaPreservesLeadingSpace() {
        XCTAssertEqual(p.parse(line: #"0:" world""#), .text(" world"))
    }

    func testErrorLine() {
        XCTAssertEqual(p.parse(line: #"3:"boom""#), .error("boom"))
    }

    func testReferencesWrappedArray() {
        let line = #"h:[{"references":[{"conversation":"c1","conversation_title":"Standup"}]}]"#
        XCTAssertEqual(
            p.parse(line: line),
            .references([ConversationReference(conversation: "c1", conversationTitle: "Standup")]))
    }

    func testBlankLineIsIgnored() {
        XCTAssertNil(p.parse(line: "   "))
    }

    func testUnknownPrefixIsPassedThrough() {
        XCTAssertEqual(p.parse(line: "9:{}"), .other(prefix: "9", payload: "{}"))
    }
}
