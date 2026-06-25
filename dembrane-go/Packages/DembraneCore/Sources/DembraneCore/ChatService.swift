import Foundation

/// A chat thread scoped to a project.
public struct Chat: Decodable, Sendable, Identifiable {
    public let id: String
    public let projectId: String?
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
