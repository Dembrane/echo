import Foundation

/// A chat thread scoped to a project.
public struct Chat: Decodable, Sendable, Identifiable {
    public let id: String
    public let projectId: String?
    public let name: String?
    public let dateCreated: Date?
}

/// A persisted chat message (history). Decoded leniently — the Directus payload
/// can send `id` as a string or an int, and we must never drop the whole history
/// because one optional field is shaped unexpectedly.
public struct ChatMessage: Decodable, Sendable, Identifiable {
    public let id: String
    public let messageFrom: String       // "user" | "assistant" | "dembrane"
    public let text: String?
    public let dateCreated: Date?

    enum CodingKeys: String, CodingKey { case id, messageFrom, text, dateCreated }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = try? c.decode(String.self, forKey: .id) { id = s }
        else if let i = try? c.decode(Int.self, forKey: .id) { id = String(i) }
        else { id = UUID().uuidString }
        messageFrom = (try? c.decode(String.self, forKey: .messageFrom)) ?? "assistant"
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? nil
        dateCreated = (try? c.decodeIfPresent(Date.self, forKey: .dateCreated)) ?? nil
    }
}

private struct ChatListResponse: Decodable { let chats: [Chat] }

/// A prompt template (workspace-shared or personal) plus app built-ins.
public struct PromptTemplate: Decodable, Identifiable, Sendable, Hashable {
    public let id: String
    public let title: String
    public let content: String
    public var scope: String? = nil
    public init(id: String, title: String, content: String, scope: String? = nil) {
        self.id = id; self.title = title; self.content = content; self.scope = scope
    }

    /// dembrane's built-in quick templates (mirrors the web defaults).
    public static let builtins: [PromptTemplate] = [
        .init(id: "dembrane:summarize", title: "Summarize",
              content: "Summarize the key points from these conversations."),
        .init(id: "dembrane:actions", title: "Action items",
              content: "What are the action items and decisions from these conversations?"),
        .init(id: "dembrane:topics", title: "Key topics",
              content: "What were the main topics and themes discussed?"),
        .init(id: "dembrane:followups", title: "Follow-ups",
              content: "What follow-up questions or next steps came up?"),
    ]
}

/// One message in the request body sent to the stream endpoint.
public struct ChatWireMessage: Encodable, Sendable {
    public let role: String
    public let content: String
    public init(role: String, content: String) {
        self.role = role
        self.content = content
    }
}

/// Talks to the chat/Ask endpoints. Streaming uses the Vercel AI data-stream
/// protocol (`0:` text, `h:` references, `3:` error), parsed by
/// `VercelAIStreamParser`.
public actor ChatService {
    private let endpoints: DembraneEndpoints
    private let session: URLSession
    private let tokenProvider: @Sendable () async -> String?

    public init(env: AppEnvironment,
                session: URLSession = .shared,
                tokenProvider: @escaping @Sendable () async -> String? = { nil }) {
        self.endpoints = DembraneEndpoints(env: env)
        self.session = session
        self.tokenProvider = tokenProvider
    }

    private func authed(_ url: URL, method: String, jsonBody: Data? = nil) async -> URLRequest {
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let jsonBody {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = jsonBody
        }
        if let token = await tokenProvider() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return req
    }

    /// Create a chat. `autoSelect` lets the backend pull in relevant
    /// conversations automatically (used when no specific context is chosen).
    public func createChat(projectId: String, autoSelect: Bool) async throws -> Chat {
        let body = try JSONSerialization.data(withJSONObject: [
            "project_id": projectId,
            "auto_select": autoSelect,
        ])
        let req = await authed(endpoints.createChat(), method: "POST", jsonBody: body)
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw APIError.badStatus(code) }
        return try DembraneJSON.decoder().decode(Chat.self, from: data)
    }

    /// Workspace-shared + personal prompt templates.
    public func listTemplates(workspaceId: String?) async throws -> [PromptTemplate] {
        let req = await authed(endpoints.promptTemplates(workspaceId: workspaceId), method: "GET")
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw APIError.badStatus(code) }
        return try DembraneJSON.decoder().decode([PromptTemplate].self, from: data)
    }

    /// Past chats for a project (those with messages), newest first.
    public func listChats(projectId: String) async throws -> [Chat] {
        let req = await authed(endpoints.chats(projectId: projectId), method: "GET")
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw APIError.badStatus(code) }
        return try DembraneJSON.decoder().decode(ChatListResponse.self, from: data).chats
    }

    /// Message history for a chat (oldest first for display).
    public func chatMessages(chatId: String) async throws -> [ChatMessage] {
        let req = await authed(endpoints.chatMessages(chatId: chatId), method: "GET")
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw APIError.badStatus(code) }
        return try DembraneJSON.decoder().decode([ChatMessage].self, from: data)
    }

    /// Scope the chat to one conversation (specific-context mode).
    public func addContext(chatId: String, conversationId: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["conversation_id": conversationId])
        let req = await authed(endpoints.addChatContext(chatId: chatId), method: "POST", jsonBody: body)
        let (_, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw APIError.badStatus(code) }
    }

    /// Send the message history and stream the assistant's reply.
    public func streamMessage(chatId: String, messages: [ChatWireMessage]) -> AsyncThrowingStream<SSEEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                let parser = VercelAIStreamParser()
                do {
                    var comps = URLComponents(
                        url: endpoints.chatStream(chatId: chatId), resolvingAgainstBaseURL: false)!
                    comps.queryItems = [
                        URLQueryItem(name: "protocol", value: "data"),
                        URLQueryItem(name: "language", value: "en"),
                    ]
                    let payload = try JSONEncoder().encode(ChatRequestBody(messages: messages))
                    let req = await authed(comps.url!, method: "POST", jsonBody: payload)
                    let (bytes, resp) = try await session.bytes(for: req)
                    let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
                    guard (200..<300).contains(code) else { throw APIError.badStatus(code) }
                    for try await line in bytes.lines {
                        if let event = parser.parse(line: line) {
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

private struct ChatRequestBody: Encodable {
    let messages: [ChatWireMessage]
}
