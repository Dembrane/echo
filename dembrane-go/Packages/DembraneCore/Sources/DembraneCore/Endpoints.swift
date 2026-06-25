import Foundation

/// Builds dembrane API URLs for a given environment. Pure + Sendable so it's
/// trivially testable.
public struct DembraneEndpoints: Sendable, Equatable {
    public let env: AppEnvironment
    public init(env: AppEnvironment) { self.env = env }

    private var api: URL { env.apiBaseURL }

    // Authenticated (BFF / v2)
    public func me() -> URL { api.appending(path: "v2/me") }
    public func register() -> URL { api.appending(path: "v2/auth/register") }
    public func workspaces() -> URL { api.appending(path: "v2/workspaces") }
    public func workspaceUsage(workspaceId: String) -> URL {
        api.appending(path: "v2/workspaces/\(workspaceId)/usage")
    }
    public func projects(workspaceId: String) -> URL {
        api.appending(path: "v2/workspaces/\(workspaceId)/projects")
    }
    public func conversations(projectId: String) -> URL {
        var c = URLComponents(url: api.appending(path: "v2/bff/conversations"),
                              resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "project_id", value: projectId)]
        return c.url!
    }
    public func conversation(id: String) -> URL {
        api.appending(path: "v2/bff/conversations/\(id)")
    }
    /// Soft-delete (sets deleted_at; audio kept for a grace period). Note: this
    /// lives on the v1 `/api/conversations/{id}` route, not under `/v2/bff`.
    public func deleteConversation(id: String) -> URL {
        api.appending(path: "conversations/\(id)")
    }
    /// Move a conversation to another project. Body: {target_project_id}.
    public func moveConversation(id: String) -> URL {
        api.appending(path: "v2/bff/conversations/\(id)/move")
    }
    public func createChat() -> URL { api.appending(path: "v2/bff/chats") }

    // Chat (streaming + context)
    public func addChatContext(chatId: String) -> URL {
        api.appending(path: "chats/\(chatId)/add-context")
    }
    public func chatStream(chatId: String) -> URL { api.appending(path: "chats/\(chatId)") }
    public func chatSuggestions(chatId: String) -> URL {
        api.appending(path: "chats/\(chatId)/suggestions")
    }

    // Recording (participant flow — used even by authed users)
    public func initiateConversation(projectId: String) -> URL {
        api.appending(path: "participant/projects/\(projectId)/conversations/initiate")
    }
    public func getUploadURL(conversationId: String) -> URL {
        api.appending(path: "participant/conversations/\(conversationId)/get-upload-url")
    }
    public func confirmUpload(conversationId: String) -> URL {
        api.appending(path: "participant/conversations/\(conversationId)/confirm-upload")
    }
    public func finishConversation(conversationId: String) -> URL {
        api.appending(path: "participant/conversations/\(conversationId)/finish")
    }
}
