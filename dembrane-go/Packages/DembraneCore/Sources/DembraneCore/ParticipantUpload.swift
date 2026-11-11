import Foundation

/// A presigned S3 POST ticket returned by `get-upload-url`.
public struct UploadTicket: Sendable, Equatable {
    public let chunkId: String
    public let uploadURL: URL
    public let fields: [String: String]
    public let fileURL: String
}

public enum UploadError: Error, Sendable, Equatable {
    case badStatus(Int)
    case s3Status(Int)
    case badResponse
}

/// Where the per-conversation upload tokens are kept. A protocol so the app
/// keeps them on disk (a recording interrupted by an app kill is uploaded on a
/// later launch) while tests keep them in memory.
public protocol ParticipantTokenStore: Sendable {
    func token(conversationId: String) -> String?
    func set(_ token: String?, conversationId: String)
}

public final class InMemoryParticipantTokenStore: ParticipantTokenStore, @unchecked Sendable {
    private var tokens: [String: String] = [:]
    private let lock = NSLock()
    public init() {}
    public func token(conversationId: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return tokens[conversationId]
    }
    public func set(_ token: String?, conversationId: String) {
        lock.lock(); defer { lock.unlock() }
        tokens[conversationId] = token
    }
}

/// Tokens of conversations still being uploaded, one small dictionary in
/// UserDefaults. An entry is removed when its conversation is finished.
public final class UserDefaultsParticipantTokenStore: ParticipantTokenStore, @unchecked Sendable {
    private let key: String
    private let defaults: UserDefaults
    private let lock = NSLock()

    public init(key: String = "com.dembrane.go.participantTokens", defaults: UserDefaults = .standard) {
        self.key = key
        self.defaults = defaults
    }

    public func token(conversationId: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return (defaults.dictionary(forKey: key) as? [String: String])?[conversationId]
    }
    public func set(_ token: String?, conversationId: String) {
        lock.lock(); defer { lock.unlock() }
        var all = (defaults.dictionary(forKey: key) as? [String: String]) ?? [:]
        all[conversationId] = token
        defaults.set(all, forKey: key)
    }
}

/// Drives the dembrane participant recording flow: create a conversation in a
/// project → upload an audio file to S3 → confirm → finish. These endpoints
/// need no sign-in; the conversation lands in the given project, which must
/// have `is_conversation_allowed = true`.
///
/// Creating the conversation returns a token in the `x-participant-token`
/// header. It is the credential for that one conversation and goes back on
/// every later call for it. A conversation started before the app kept tokens
/// has none; the server accepts those calls until it makes the token mandatory.
public actor ParticipantUploadClient {
    public static let tokenHeader = "x-participant-token"

    private let endpoints: DembraneEndpoints
    private let session: URLSession
    private let tokens: ParticipantTokenStore

    public init(env: AppEnvironment, session: URLSession = .shared,
                tokens: ParticipantTokenStore = UserDefaultsParticipantTokenStore()) {
        self.endpoints = DembraneEndpoints(env: env)
        self.session = session
        self.tokens = tokens
    }

    /// Run the whole flow. Returns the created conversation id.
    @discardableResult
    public func upload(projectId: String, fileURL: URL, displayName: String,
                       contentType: String, source: String = "GO_IOS",
                       recordedAt: Date) async throws -> String {
        let conversationId = try await initiate(projectId: projectId, name: displayName, source: source)
        let ticket = try await uploadTicket(conversationId: conversationId,
                                            filename: fileURL.lastPathComponent, contentType: contentType)
        try await putToS3(ticket: ticket, fileURL: fileURL, contentType: contentType)
        try await confirm(conversationId: conversationId, chunkId: ticket.chunkId,
                          fileURL: ticket.fileURL, source: source, timestamp: recordedAt)
        try await finish(conversationId: conversationId)
        return conversationId
    }

    // MARK: - Chunked session (record start → upload each 30s segment → finish)

    /// Create the conversation; returns its id. Call once at record start.
    public func startConversation(projectId: String, displayName: String,
                                  source: String = "GO_IOS") async throws -> String {
        try await initiate(projectId: projectId, name: displayName, source: source)
    }

    /// Upload one audio segment as a chunk of an existing conversation.
    public func uploadChunk(conversationId: String, fileURL: URL,
                            contentType: String = "audio/m4a",
                            source: String = "GO_IOS", timestamp: Date) async throws {
        let ticket = try await uploadTicket(conversationId: conversationId,
                                            filename: fileURL.lastPathComponent, contentType: contentType)
        try await putToS3(ticket: ticket, fileURL: fileURL, contentType: contentType)
        try await confirm(conversationId: conversationId, chunkId: ticket.chunkId,
                          fileURL: ticket.fileURL, source: source, timestamp: timestamp)
    }

    /// Mark the conversation complete. Call once when recording stops.
    public func finishConversation(conversationId: String) async throws {
        try await finish(conversationId: conversationId)
    }

    func initiate(projectId: String, name: String, source: String) async throws -> String {
        let (data, http) = try await send(endpoints.initiateConversation(projectId: projectId),
                                          ["name": name, "pin": "go", "source": source, "tag_id_list": []])
        guard let id = (try? DembraneJSON.decoder().decode(InitiateResponse.self, from: data))?.id else {
            throw UploadError.badResponse
        }
        if let token = http?.value(forHTTPHeaderField: Self.tokenHeader), !token.isEmpty {
            tokens.set(token, conversationId: id)
        }
        return id
    }

    func uploadTicket(conversationId: String, filename: String, contentType: String) async throws -> UploadTicket {
        let data = try await postJSON(endpoints.getUploadURL(conversationId: conversationId),
                                      ["filename": filename, "content_type": contentType,
                                       "conversation_id": conversationId],
                                      conversationId: conversationId)
        guard let r = try? DembraneJSON.decoder().decode(UploadURLResponse.self, from: data),
              let url = URL(string: r.uploadUrl) else { throw UploadError.badResponse }
        return UploadTicket(chunkId: r.chunkId, uploadURL: url, fields: r.fields, fileURL: r.fileUrl)
    }

    func putToS3(ticket: UploadTicket, fileURL: URL, contentType: String) async throws {
        let boundary = "dembrane-\(UUID().uuidString)"
        var body = Data()
        for (key, value) in ticket.fields {            // the `file` part MUST come last
            body.append("--\(boundary)\r\n")
            body.append("Content-Disposition: form-data; name=\"\(key)\"\r\n\r\n")
            body.append("\(value)\r\n")
        }
        let fileData = try Data(contentsOf: fileURL)
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileURL.lastPathComponent)\"\r\n")
        body.append("Content-Type: \(contentType)\r\n\r\n")
        body.append(fileData)
        body.append("\r\n--\(boundary)--\r\n")

        var req = URLRequest(url: ticket.uploadURL)
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let (_, resp) = try await session.upload(for: req, from: body)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw UploadError.s3Status(code) }
    }

    func confirm(conversationId: String, chunkId: String, fileURL: String,
                 source: String, timestamp: Date) async throws {
        _ = try await postJSON(endpoints.confirmUpload(conversationId: conversationId),
                               ["chunk_id": chunkId, "file_url": fileURL,
                                "timestamp": Self.iso8601.string(from: timestamp), "source": source],
                               conversationId: conversationId)
    }

    func finish(conversationId: String) async throws {
        _ = try await postJSON(endpoints.finishConversation(conversationId: conversationId), [:],
                               conversationId: conversationId)
        tokens.set(nil, conversationId: conversationId)
    }

    /// A call on an existing conversation: carries its token when one is known.
    @discardableResult
    private func postJSON(_ url: URL, _ json: [String: Any], conversationId: String) async throws -> Data {
        try await send(url, json, token: tokens.token(conversationId: conversationId)).0
    }

    private func send(_ url: URL, _ json: [String: Any],
                      token: String? = nil) async throws -> (Data, HTTPURLResponse?) {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { req.setValue(token, forHTTPHeaderField: Self.tokenHeader) }
        req.httpBody = try JSONSerialization.data(withJSONObject: json)
        let (data, resp) = try await session.data(for: req)
        let http = resp as? HTTPURLResponse
        let code = http?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw UploadError.badStatus(code) }
        return (data, http)
    }

    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}

struct InitiateResponse: Decodable { let id: String }
struct UploadURLResponse: Decodable {
    let chunkId: String
    let uploadUrl: String
    let fields: [String: String]
    let fileUrl: String
}

private extension Data {
    mutating func append(_ string: String) { append(Data(string.utf8)) }
}
