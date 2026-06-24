import Foundation

// MARK: - JSON

/// Shared JSON coding for the dembrane API: snake_case keys, lenient ISO-8601
/// dates (with or without fractional seconds).
public enum DembraneJSON {
    public static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        // The dembrane API (Directus) serializes timestamps as ISO-8601 with
        // milliseconds and a Z suffix, e.g. "2026-06-24T10:54:54.796Z".
        d.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            guard let date = directusDate(raw) else {
                throw DecodingError.dataCorruptedError(
                    in: container, debugDescription: "Expected ISO-8601 date, got: \(raw)")
            }
            return date
        }
        return d
    }

    public static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        return e
    }

    /// Directus emits ISO-8601 with milliseconds + Z; the standard also permits
    /// no fractional seconds. Accept both legal forms — and nothing else.
    private static func directusDate(_ raw: String) -> Date? {
        isoWithMillis.date(from: raw) ?? isoPlain.date(from: raw)
    }
    private static let isoWithMillis: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}

// MARK: - User / orgs

public struct Me: Codable, Sendable, Equatable {
    public let id: String?
    public let directusUserId: String
    public let email: String
    public let displayName: String
    public let onboardingCompleted: Bool
    public let orgs: [OrgSummary]
}

public struct OrgSummary: Codable, Sendable, Hashable {
    public let id: String?
    public let name: String
    public let role: String?
    public let isPartner: Bool?
}

// MARK: - Workspace / project

public struct Workspace: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let orgId: String?
    public let orgName: String?
    public let isDefault: Bool
    public let tier: String?
    public let projectCount: Int?
    public let memberCount: Int?
}

public struct Project: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let workspaceId: String?
    public let language: String?
}

/// Over-cap / upload gating for a workspace (free tier = 1 hour).
public struct WorkspaceUsage: Codable, Sendable, Equatable {
    public let overCapActive: Bool
    public let uploadsLocked: Bool
    public let upgradeCtaTier: String?
}

// MARK: - Conversation

public struct Conversation: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let projectId: String?
    public let participantName: String?
    public let title: String?
    public let summary: String?
    public let mergedTranscript: String?
    public let duration: Double?
    public let isFinished: Bool?
    public let isAudioProcessingFinished: Bool?
    public let locked: Bool?
    public let lockReason: String?
    public let createdAt: Date?

    /// Display title: the auto-generated participant title, else the title,
    /// else a placeholder (mirrors the web frontend).
    public var displayTitle: String {
        participantName ?? title ?? "Untitled conversation"
    }

    /// Human label for the processing state shown on a card.
    public var statusLabel: String {
        if locked == true { return "Locked" }
        if isFinished != true { return "Recording" }
        if isAudioProcessingFinished == true { return "Ready" }
        return "Processing audio…"
    }
}

public struct ConversationChunk: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let conversationId: String?
    public let transcript: String?
    public let timestamp: Date?
    public let source: String?
}

/// A citation returned in the chat stream's `h:` header line.
public struct ConversationReference: Codable, Sendable, Hashable {
    public let conversation: String
    public let conversationTitle: String?

    public init(conversation: String, conversationTitle: String?) {
        self.conversation = conversation
        self.conversationTitle = conversationTitle
    }
}

// MARK: - Previews (used by MockAPIClient + SwiftUI previews)

public extension Me {
    static let preview = Me(
        id: "u_preview", directusUserId: "du_preview", email: "you@dembrane.com",
        displayName: "you", onboardingCompleted: true, orgs: [.preview])
}
public extension OrgSummary {
    static let preview = OrgSummary(id: "o_preview", name: "your org", role: "owner", isPartner: false)
}
public extension Workspace {
    static let preview = Workspace(
        id: "w_preview", name: "your workspace", orgId: "o_preview", orgName: "your org",
        isDefault: true, tier: "free", projectCount: 1, memberCount: 1)
}
public extension Project {
    static let preview = Project(id: "p_preview", name: "go", workspaceId: "w_preview", language: "en")
}
public extension Conversation {
    static let previews: [Conversation] = [
        Conversation(id: "c1", projectId: "p_preview", participantName: "Morning sync",
                     title: "Morning sync", summary: "Quick standup about the launch.",
                     mergedTranscript: nil, duration: 312, isFinished: true,
                     isAudioProcessingFinished: true, locked: false, lockReason: nil, createdAt: nil),
        Conversation(id: "c2", projectId: "p_preview", participantName: nil,
                     title: "Field interview", summary: nil, mergedTranscript: nil, duration: 1840,
                     isFinished: true, isAudioProcessingFinished: false,
                     locked: false, lockReason: nil, createdAt: nil),
        Conversation(id: "c3", projectId: "p_preview", participantName: nil,
                     title: "Voice note", summary: nil, mergedTranscript: nil, duration: 47,
                     isFinished: true, isAudioProcessingFinished: true,
                     locked: true, lockReason: "free_tier", createdAt: nil),
    ]
}
