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

/// Drives the dembrane participant recording flow: create a conversation in a
/// project → upload an audio file to S3 → confirm → finish. These endpoints are
/// public (no auth); the conversation lands in the given project, which must
/// have `is_conversation_allowed = true`.
public actor ParticipantUploadClient {
    private let endpoints: DembraneEndpoints
    private let session: URLSession

    public init(env: AppEnvironment, session: URLSession = .shared) {
        self.endpoints = DembraneEndpoints(env: env)
        self.session = session
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

    func initiate(projectId: String, name: String, source: String) async throws -> String {
        let data = try await postJSON(endpoints.initiateConversation(projectId: projectId),
                                      ["name": name, "pin": "go", "source": source, "tag_id_list": []])
        guard let id = (try? DembraneJSON.decoder().decode(InitiateResponse.self, from: data))?.id else {
            throw UploadError.badResponse
        }
        return id
    }

    func uploadTicket(conversationId: String, filename: String, contentType: String) async throws -> UploadTicket {
        let data = try await postJSON(endpoints.getUploadURL(conversationId: conversationId),
                                      ["filename": filename, "content_type": contentType,
                                       "conversation_id": conversationId])
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
                                "timestamp": Self.iso8601.string(from: timestamp), "source": source])
    }

    func finish(conversationId: String) async throws {
        _ = try await postJSON(endpoints.finishConversation(conversationId: conversationId), [:])
    }

    @discardableResult
    private func postJSON(_ url: URL, _ json: [String: Any]) async throws -> Data {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = try JSONSerialization.data(withJSONObject: json)
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw UploadError.badStatus(code) }
        return data
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
