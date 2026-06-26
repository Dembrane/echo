import Foundation

public enum APIError: Error, Sendable, Equatable {
    case badStatus(Int)
    case notImplemented
}

/// The surface the app + previews talk to. A protocol so the UI can run against
/// `MockAPIClient` with no network.
public protocol DembraneAPIClientProtocol: Sendable {
    func me() async throws -> Me
    func workspaces() async throws -> [Workspace]
    func workspaceUsage(workspaceId: String) async throws -> WorkspaceUsage
    func projects(workspaceId: String) async throws -> [Project]
    func conversations(projectId: String) async throws -> [Conversation]
    func conversation(id: String) async throws -> Conversation
    func conversationChunks(id: String) async throws -> [ConversationChunk]
    /// Resolves the signed playback URL for a conversation's merged audio.
    func conversationAudioURL(id: String) async throws -> URL
    func updateConversation(id: String, fields: [String: String]) async throws
    func moveConversation(id: String, targetProjectId: String) async throws
    func summarizeConversation(id: String) async throws
    func generateConversationTitle(id: String) async throws
    func retranscribeConversation(id: String) async throws
    func deleteConversation(id: String) async throws
    func createProject(workspaceId: String, name: String) async throws -> Project
    func projectTags(projectId: String) async throws -> [ProjectTag]
    func conversationTags(conversationId: String) async throws -> [ProjectTag]
    func createTag(projectId: String, text: String) async throws -> ProjectTag
    func replaceConversationTags(conversationId: String, tagIds: [String]) async throws
}

/// Real client. Cookie-based Directus session is carried by the injected
/// URLSession's `HTTPCookieStorage`. Response envelopes are decoded leniently;
/// they'll be tightened in M1 when wired against the live server.
public actor LiveAPIClient: DembraneAPIClientProtocol {
    private let endpoints: DembraneEndpoints
    private let session: URLSession
    private let tokenProvider: @Sendable () async -> String?
    private let onUnauthorized: (@Sendable () async -> Bool)?

    public init(env: AppEnvironment,
                session: URLSession = .shared,
                tokenProvider: @escaping @Sendable () async -> String? = { nil },
                onUnauthorized: (@Sendable () async -> Bool)? = nil) {
        self.endpoints = DembraneEndpoints(env: env)
        self.session = session
        self.tokenProvider = tokenProvider
        self.onUnauthorized = onUnauthorized
    }

    private func get<T: Decodable>(_ url: URL, as type: T.Type, retrying: Bool = true) async throws -> T {
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = await tokenProvider() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        // One refresh-and-retry on 401.
        if code == 401, retrying, let onUnauthorized, await onUnauthorized() {
            return try await get(url, as: type, retrying: false)
        }
        guard (200..<300).contains(code) else { throw APIError.badStatus(code) }
        return try DembraneJSON.decoder().decode(T.self, from: data)
    }

    public func me() async throws -> Me {
        try await get(endpoints.me(), as: Me.self)
    }
    public func workspaces() async throws -> [Workspace] {
        try await get(endpoints.workspaces(), as: WorkspaceListResponse.self).workspaces
    }
    public func workspaceUsage(workspaceId: String) async throws -> WorkspaceUsage {
        // The endpoint may return the object directly or wrapped in {data:…}.
        do {
            return try await get(endpoints.workspaceUsage(workspaceId: workspaceId), as: WorkspaceUsage.self)
        } catch {
            struct Envelope: Decodable { let data: WorkspaceUsage }
            return try await get(endpoints.workspaceUsage(workspaceId: workspaceId), as: Envelope.self).data
        }
    }
    public func projects(workspaceId: String) async throws -> [Project] {
        try await get(endpoints.projects(workspaceId: workspaceId), as: ProjectsListResponse.self).items
    }
    public func conversations(projectId: String) async throws -> [Conversation] {
        try await get(endpoints.conversations(projectId: projectId), as: [Conversation].self)
    }

    public func conversation(id: String) async throws -> Conversation {
        try await get(endpoints.conversation(id: id), as: Conversation.self)
    }

    public func updateConversation(id: String, fields: [String: String]) async throws {
        try await sendJSON(endpoints.conversation(id: id), method: "PATCH", body: fields)
    }

    public func moveConversation(id: String, targetProjectId: String) async throws {
        try await sendJSON(endpoints.moveConversation(id: id), method: "POST",
                           body: ["target_project_id": targetProjectId])
    }
    public func summarizeConversation(id: String) async throws {
        try await send(endpoints.summarizeConversation(id: id), method: "POST")
    }
    public func generateConversationTitle(id: String) async throws {
        try await send(endpoints.generateConversationTitle(id: id), method: "POST")
    }
    public func retranscribeConversation(id: String) async throws {
        try await send(endpoints.retranscribeConversation(id: id), method: "POST")
    }

    public func conversationChunks(id: String) async throws -> [ConversationChunk] {
        try await get(endpoints.conversationChunks(id: id), as: [ConversationChunk].self)
    }

    public func conversationAudioURL(id: String) async throws -> URL {
        var req = URLRequest(url: endpoints.conversationContent(id: id))
        req.httpMethod = "GET"
        if let token = await tokenProvider() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw APIError.badStatus(code) }
        // ?return_url=true returns the signed URL. Be lenient: it may arrive as a
        // bare JSON string, a {"url": …} object, or plain text.
        struct URLEnvelope: Decodable { let url: String? }
        let raw: String
        if let env = try? JSONDecoder().decode(URLEnvelope.self, from: data), let u = env.url {
            raw = u
        } else if let s = try? JSONDecoder().decode(String.self, from: data) {
            raw = s
        } else {
            raw = String(decoding: data, as: UTF8.self)
        }
        let cleaned = raw.trimmingCharacters(
            in: CharacterSet(charactersIn: "\"").union(.whitespacesAndNewlines))
        guard let url = URL(string: cleaned), url.scheme != nil else { throw APIError.badStatus(-2) }
        return url
    }

    public func deleteConversation(id: String) async throws {
        try await send(endpoints.deleteConversation(id: id), method: "DELETE")
    }

    public func createProject(workspaceId: String, name: String) async throws -> Project {
        try await post(endpoints.projects(workspaceId: workspaceId),
                       body: ["name": name, "language": "en"], as: Project.self)
    }

    public func projectTags(projectId: String) async throws -> [ProjectTag] {
        try await get(endpoints.tags(projectId: projectId), as: [ProjectTag].self)
    }
    public func conversationTags(conversationId: String) async throws -> [ProjectTag] {
        try await get(endpoints.conversationTags(conversationId: conversationId),
                      as: [ConversationTagLink].self).map(\.projectTagId)
    }
    public func createTag(projectId: String, text: String) async throws -> ProjectTag {
        try await post(endpoints.createTag(), body: ["project_id": projectId, "text": text],
                       as: ProjectTag.self)
    }
    public func replaceConversationTags(conversationId: String, tagIds: [String]) async throws {
        try await sendJSON(endpoints.replaceConversationTags(), method: "POST",
                           body: ["conversation_id": conversationId, "project_tag_ids": tagIds])
    }

    /// Authed request with a JSON body and no decoded response (e.g. PATCH).
    private func sendJSON(_ url: URL, method: String, body: [String: Any], retrying: Bool = true) async throws {
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = await tokenProvider() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (_, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if code == 401, retrying, let onUnauthorized, await onUnauthorized() {
            return try await sendJSON(url, method: method, body: body, retrying: false)
        }
        guard (200..<300).contains(code) else { throw APIError.badStatus(code) }
    }

    /// Authed request with no body and no decoded response (e.g. DELETE).
    private func send(_ url: URL, method: String, retrying: Bool = true) async throws {
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = await tokenProvider() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (_, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if code == 401, retrying, let onUnauthorized, await onUnauthorized() {
            return try await send(url, method: method, retrying: false)
        }
        guard (200..<300).contains(code) else { throw APIError.badStatus(code) }
    }

    private func post<T: Decodable>(_ url: URL, body: [String: Any], as type: T.Type,
                                    retrying: Bool = true) async throws -> T {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = await tokenProvider() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if code == 401, retrying, let onUnauthorized, await onUnauthorized() {
            return try await post(url, body: body, as: type, retrying: false)
        }
        guard (200..<300).contains(code) else { throw APIError.badStatus(code) }
        return try DembraneJSON.decoder().decode(T.self, from: data)
    }
}

/// In-memory client for previews, the app shell, and tests.
public struct MockAPIClient: DembraneAPIClientProtocol {
    public init() {}
    public func me() async throws -> Me { .preview }
    public func workspaces() async throws -> [Workspace] { [.preview] }
    public func workspaceUsage(workspaceId: String) async throws -> WorkspaceUsage {
        WorkspaceUsage(overCapActive: false, uploadsLocked: false, upgradeCtaTier: nil)
    }
    public func projects(workspaceId: String) async throws -> [Project] { [.preview] }
    public func conversations(projectId: String) async throws -> [Conversation] { Conversation.previews }
    public func conversation(id: String) async throws -> Conversation {
        Conversation(id: id, projectId: "p_preview", participantName: "Morning sync",
                     title: "Morning sync", summary: "Quick standup about the launch.",
                     mergedTranscript: "Alice: Morning everyone.\nBob: Let's review the launch plan.",
                     duration: 312, isFinished: true, isAllChunksTranscribed: true,
                     locked: false, lockReason: nil, createdAt: nil)
    }
    public func updateConversation(id: String, fields: [String: String]) async throws {}
    public func moveConversation(id: String, targetProjectId: String) async throws {}
    public func summarizeConversation(id: String) async throws {}
    public func generateConversationTitle(id: String) async throws {}
    public func retranscribeConversation(id: String) async throws {}
    public func deleteConversation(id: String) async throws {}
    public func conversationChunks(id: String) async throws -> [ConversationChunk] {
        [ConversationChunk(id: "ck1", conversationId: id,
                           transcript: "Alice: Morning everyone. Bob: Let's review the launch plan.",
                           timestamp: nil, source: "GO_IOS")]
    }
    public func conversationAudioURL(id: String) async throws -> URL { throw APIError.notImplemented }
    public func createProject(workspaceId: String, name: String) async throws -> Project {
        Project(id: "p_go", name: name, workspaceId: workspaceId, language: "en")
    }
    public func projectTags(projectId: String) async throws -> [ProjectTag] {
        [ProjectTag(id: "t1", text: "Interview"), ProjectTag(id: "t2", text: "Idea")]
    }
    public func conversationTags(conversationId: String) async throws -> [ProjectTag] { [] }
    public func createTag(projectId: String, text: String) async throws -> ProjectTag {
        ProjectTag(id: "t_new", text: text)
    }
    public func replaceConversationTags(conversationId: String, tagIds: [String]) async throws {}
}

/// Junction row from `/v2/bff/conversation-project-tags` — the expanded
/// `project_tag_id` carries the actual tag.
private struct ConversationTagLink: Decodable {
    let projectTagId: ProjectTag
}

// MARK: - Response envelopes

struct WorkspaceListResponse: Decodable { let workspaces: [Workspace] }

struct ProjectsListResponse: Decodable {
    let items: [Project]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = (try? c.decode([Project].self, forKey: .data))
            ?? (try? c.decode([Project].self, forKey: .projects))
            ?? []
    }
    enum CodingKeys: String, CodingKey { case data, projects }
}
