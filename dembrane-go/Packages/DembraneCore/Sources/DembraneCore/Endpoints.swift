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
    /// Public participant view of a project (portal defaults; no auth).
    public func participantProject(id: String) -> URL {
        api.appending(path: "participant/projects/\(id)")
    }
    /// Authed project resource for PATCHing portal settings.
    public func project(id: String) -> URL {
        api.appending(path: "v2/bff/projects/\(id)")
    }
    /// Authed host read of a project's portal defaults — the same row the
    /// PATCH writes, so edits round-trip. `default_conversation_transcript_prompt`
    /// is the dashboard's "Specific Context" (key terms) field.
    public func projectPortalRead(id: String) -> URL {
        var c = URLComponents(url: api.appending(path: "v2/projects/\(id)/bff"),
                              resolvingAgainstBaseURL: false)!
        c.queryItems = [
            URLQueryItem(name: "include_tags", value: "false"),
            URLQueryItem(name: "fields",
                         value: "default_conversation_title,default_conversation_description,default_conversation_transcript_prompt"),
        ]
        return c.url!
    }
    /// Projects in a workspace. The route defaults to 15/page (max 100) sorted by
    /// recent, so pass the max limit and an optional server-side `search` so any
    /// project is findable, not just the most recent few.
    public func projects(workspaceId: String, search: String? = nil) -> URL {
        var c = URLComponents(url: api.appending(path: "v2/workspaces/\(workspaceId)/projects"),
                              resolvingAgainstBaseURL: false)!
        var items = [URLQueryItem(name: "limit", value: "100")]
        if let search, !search.isEmpty { items.append(URLQueryItem(name: "search", value: search)) }
        c.queryItems = items
        return c.url!
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
    public func conversationChunks(id: String) -> URL {
        api.appending(path: "v2/bff/conversations/\(id)/chunks")
    }
    /// Signed URL for the merged conversation audio. `?return_url=true` returns the
    /// signed S3 URL (as a string) instead of redirecting. v1 `/api` route.
    public func conversationContent(id: String) -> URL {
        var c = URLComponents(url: api.appending(path: "conversations/\(id)/content"),
                              resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "return_url", value: "true")]
        return c.url!
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
    // Conversation actions (v1 /api/conversations/{id}/…, Bearer-authed, bodyless POST).
    public func summarizeConversation(id: String) -> URL {
        api.appending(path: "conversations/\(id)/summarize")
    }
    public func generateConversationTitle(id: String) -> URL {
        api.appending(path: "conversations/\(id)/generate-title")
    }
    public func retranscribeConversation(id: String) -> URL {
        api.appending(path: "conversations/\(id)/retranscribe")
    }
    public func createChat() -> URL { api.appending(path: "v2/bff/chats") }
    public func chats(projectId: String) -> URL {
        var c = URLComponents(url: api.appending(path: "v2/bff/chats"), resolvingAgainstBaseURL: false)!
        c.queryItems = [
            URLQueryItem(name: "project_id", value: projectId),
            URLQueryItem(name: "has_messages", value: "true"),
            URLQueryItem(name: "limit", value: "30"),
        ]
        return c.url!
    }
    public func promptTemplates(workspaceId: String?) -> URL {
        var c = URLComponents(url: api.appending(path: "templates/prompt-templates"),
                              resolvingAgainstBaseURL: false)!
        if let workspaceId { c.queryItems = [URLQueryItem(name: "workspace_id", value: workspaceId)] }
        return c.url!
    }
    public func chatMessages(chatId: String) -> URL {
        var c = URLComponents(url: api.appending(path: "v2/bff/chat-messages"), resolvingAgainstBaseURL: false)!
        c.queryItems = [
            URLQueryItem(name: "chat_id", value: chatId),
            URLQueryItem(name: "limit", value: "100"),
        ]
        return c.url!
    }

    // Tags (project-scoped)
    public func tags(projectId: String) -> URL {
        var c = URLComponents(url: api.appending(path: "v2/bff/tags"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "project_id", value: projectId)]
        return c.url!
    }
    public func createTag() -> URL { api.appending(path: "v2/bff/tags") }
    public func conversationTags(conversationId: String) -> URL {
        var c = URLComponents(url: api.appending(path: "v2/bff/conversation-project-tags"),
                              resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "conversation_id", value: conversationId)]
        return c.url!
    }
    public func replaceConversationTags() -> URL {
        api.appending(path: "v2/bff/conversation-project-tags/replace")
    }

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
