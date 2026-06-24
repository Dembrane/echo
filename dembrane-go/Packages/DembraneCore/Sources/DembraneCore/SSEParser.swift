import Foundation

/// One decoded event from the chat stream (Vercel AI data-stream protocol:
/// each line is `<prefix>:<json>`).
public enum SSEEvent: Equatable, Sendable {
    case text(String)                       // 0: text delta
    case references([ConversationReference]) // h: citations
    case error(String)                      // 3: error
    case other(prefix: String, payload: String)
}

/// Parses Vercel AI data-stream lines. Lenient by design — anything it doesn't
/// recognize comes back as `.other` rather than throwing, so the stream UI
/// never dies on an unexpected line.
public struct VercelAIStreamParser: Sendable {
    public init() {}

    public func parse(line: String) -> SSEEvent? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let colon = trimmed.firstIndex(of: ":") else {
            return .other(prefix: "", payload: trimmed)
        }
        let prefix = String(trimmed[trimmed.startIndex..<colon])
        let payload = String(trimmed[trimmed.index(after: colon)...])
        let data = Data(payload.utf8)

        switch prefix {
        case "0":
            if let s = try? JSONDecoder().decode(String.self, from: data) { return .text(s) }
            return .other(prefix: prefix, payload: payload)
        case "3":
            if let s = try? JSONDecoder().decode(String.self, from: data) { return .error(s) }
            return .error(payload)
        case "h":
            if let refs = decodeReferences(from: data) { return .references(refs) }
            return .other(prefix: prefix, payload: payload)
        default:
            return .other(prefix: prefix, payload: payload)
        }
    }

    /// The `h:` payload has been seen as a bare array of refs, a single wrapper,
    /// or an array of wrappers — accept all three.
    private func decodeReferences(from data: Data) -> [ConversationReference]? {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        if let arr = try? d.decode([ReferencesWrapper].self, from: data) {
            return arr.flatMap { $0.references }
        }
        if let one = try? d.decode(ReferencesWrapper.self, from: data) {
            return one.references
        }
        if let bare = try? d.decode([ConversationReference].self, from: data) {
            return bare
        }
        return nil
    }
}

private struct ReferencesWrapper: Decodable {
    let references: [ConversationReference]
}
