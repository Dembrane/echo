import XCTest
@testable import DembraneCore

final class ModelTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try DembraneJSON.decoder().decode(T.self, from: Data(json.utf8))
    }

    func testConversationDecodesSnakeCaseAndDate() throws {
        let c = try decode(Conversation.self, """
        {"id":"c1","project_id":"p1","title":"Morning sync","summary":null,
         "duration":123.5,"is_finished":true,"is_audio_processing_finished":false,
         "locked":false,"lock_reason":null,"created_at":"2026-01-15T10:30:00Z"}
        """)
        XCTAssertEqual(c.id, "c1")
        XCTAssertEqual(c.projectId, "p1")
        XCTAssertEqual(c.duration, 123.5)
        XCTAssertEqual(c.isFinished, true)
        XCTAssertEqual(c.isAudioProcessingFinished, false)
        XCTAssertNotNil(c.createdAt)
    }

    func testConversationStatusLabel() {
        XCTAssertEqual(Conversation.previews[0].statusLabel, "Ready")
        XCTAssertEqual(Conversation.previews[1].statusLabel, "Processing audio…")
        XCTAssertEqual(Conversation.previews[2].statusLabel, "Locked")
    }

    func testFractionalDateDecodes() throws {
        let c = try decode(Conversation.self,
            #"{"id":"c","project_id":"p","created_at":"2026-01-15T10:30:00.500Z"}"#)
        XCTAssertNotNil(c.createdAt)
    }

    func testWorkspaceDecodes() throws {
        let w = try decode(Workspace.self,
            #"{"id":"w1","name":"My Workspace","org_id":"o1","is_default":true,"tier":"free"}"#)
        XCTAssertEqual(w.isDefault, true)
        XCTAssertEqual(w.tier, "free")
        XCTAssertNil(w.projectCount)
    }

    func testMeDecodesWithOrgs() throws {
        let me = try decode(Me.self, """
        {"id":"u1","directus_user_id":"du1","email":"a@b.com","display_name":"you",
         "onboarding_completed":true,"orgs":[{"name":"Org","role":"owner","is_partner":false}]}
        """)
        XCTAssertEqual(me.directusUserId, "du1")
        XCTAssertEqual(me.displayName, "you")
        XCTAssertEqual(me.orgs.first?.name, "Org")
    }
}
