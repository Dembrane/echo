import XCTest
@testable import DembraneCore

/// Walks the app's core flow against a real environment: sign in, list
/// projects, upload a recording in two segments, wait for the transcript, sign
/// out. Skipped unless the environment names an account, so a normal test run
/// never touches the network:
///
///     DEMBRANE_LIVE_ENV=staging DEMBRANE_LIVE_EMAIL=… DEMBRANE_LIVE_PASSWORD=… \
///     DEMBRANE_LIVE_CLIPS=/path/a.m4a:/path/b.m4a swift test --filter LiveWalkTests
///
/// Use a throwaway account: when it is already on two devices, the walk signs
/// out the one used least recently.
final class LiveWalkTests: XCTestCase {
    func testCoreFlow() async throws {
        let vars = ProcessInfo.processInfo.environment
        guard let email = vars["DEMBRANE_LIVE_EMAIL"], let password = vars["DEMBRANE_LIVE_PASSWORD"],
              let env = AppEnvironment(rawValue: vars["DEMBRANE_LIVE_ENV"] ?? "") else {
            throw XCTSkip("no live account configured")
        }
        let clips = (vars["DEMBRANE_LIVE_CLIPS"] ?? "").split(separator: ":").map { URL(fileURLWithPath: String($0)) }
        try XCTSkipIf(clips.isEmpty, "no clips configured")

        let manager = SessionManager(store: InMemorySessionStore())
        let auth = AuthService(env: env, sessionManager: manager,
                               deviceId: "live-walk-\(UUID().uuidString.lowercased())")
        do {
            _ = try await auth.login(email: email, password: password)
        } catch AuthError.signedInElsewhere(let devices) {
            _ = try await auth.replaceOtherDevice(try XCTUnwrap(devices.last).id)
        }
        let alive = try await auth.refresh()
        XCTAssertTrue(alive)

        let api = LiveAPIClient(env: env, tokenProvider: { await manager.accessToken() })
        let me = try await api.me()
        XCTAssertEqual(me.email.lowercased(), email.lowercased())
        let workspaces = try await api.workspaces()
        let workspace = try XCTUnwrap(workspaces.first)
        let name = "Go live walk (fake)"
        let listed = try await api.projects(workspaceId: workspace.id, search: name)
        let project: Project
        if let existing = listed.first(where: { $0.name == name }) {
            project = existing
        } else {
            project = try await api.createProject(workspaceId: workspace.id, name: name)
        }

        let uploader = ParticipantUploadClient(env: env, tokens: InMemoryParticipantTokenStore())
        let conversationId = try await uploader.startConversation(
            projectId: project.id, displayName: "Go live walk \(Int(Date().timeIntervalSince1970))")
        for clip in clips {
            try await uploader.uploadChunk(conversationId: conversationId, fileURL: clip, timestamp: Date())
        }
        try await uploader.finishConversation(conversationId: conversationId)

        var transcript = ""
        for _ in 0..<36 where transcript.isEmpty {
            try await Task.sleep(for: .seconds(5))
            let chunks = try await api.conversationChunks(id: conversationId)
            XCTAssertEqual(chunks.count, clips.count)
            if chunks.allSatisfy({ $0.transcript?.isEmpty == false }) {
                transcript = chunks.compactMap(\.transcript).joined(separator: " ")
            }
        }
        XCTAssertFalse(transcript.isEmpty, "no transcript within three minutes")
        let conversation = try await api.conversation(id: conversationId)
        XCTAssertEqual(conversation.source, "GO_IOS")
        XCTAssertEqual(conversation.isFinished, true)
        let inList = try await api.conversations(projectId: project.id)
        XCTAssertTrue(inList.contains { $0.id == conversationId })
        _ = try await api.conversationAudioURL(id: conversationId)
        print("live walk: conversation \(conversationId) transcribed, \(transcript.count) characters")

        // The token must stop working on the server, not only be forgotten here.
        let token = await manager.accessToken()
        await auth.logout()
        let signedIn = await manager.isAuthenticated()
        XCTAssertFalse(signedIn)
        let gone = LiveAPIClient(env: env, tokenProvider: { token })
        do {
            _ = try await gone.me()
            XCTFail("expected 401 without a session")
        } catch {
            XCTAssertEqual(error as? APIError, .badStatus(401))
        }
    }
}
