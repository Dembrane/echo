import XCTest
@testable import DembraneCore

final class ParticipantUploadTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.handler = nil
        super.tearDown()
    }

    func testInitiateReturnsConversationId() async throws {
        var capturedBody: [String: Any]?
        MockURLProtocol.handler = { req in
            if let stream = req.httpBodyStream { capturedBody = Self.readJSON(stream) }
            let json = #"{"id":"conv-1","project_id":"p1","participant_name":"you"}"#
            return (Self.ok(req), Data(json.utf8))
        }
        let client = ParticipantUploadClient(env: .echoNext, session: MockURLProtocol.makeSession())
        let id = try await client.initiate(projectId: "p1", name: "you", source: "GO_IOS")
        XCTAssertEqual(id, "conv-1")
        XCTAssertEqual(capturedBody?["source"] as? String, "GO_IOS")
        XCTAssertEqual(capturedBody?["name"] as? String, "you")
    }

    func testUploadTicketParsesPresignedFields() async throws {
        MockURLProtocol.handler = { req in
            let json = """
            {"chunk_id":"ch1","upload_url":"https://s3.example.com/bucket",
             "file_url":"https://s3.example.com/bucket/conversation/conv-1/chunks/ch1-r.m4a",
             "fields":{"key":"conversation/conv-1/chunks/ch1-r.m4a","policy":"p","x-amz-signature":"sig"}}
            """
            return (Self.ok(req), Data(json.utf8))
        }
        let client = ParticipantUploadClient(env: .echoNext, session: MockURLProtocol.makeSession())
        let ticket = try await client.uploadTicket(conversationId: "conv-1", filename: "r.m4a", contentType: "audio/m4a")
        XCTAssertEqual(ticket.chunkId, "ch1")
        XCTAssertEqual(ticket.uploadURL.absoluteString, "https://s3.example.com/bucket")
        XCTAssertEqual(ticket.fields["key"], "conversation/conv-1/chunks/ch1-r.m4a")
        XCTAssertEqual(ticket.fields["x-amz-signature"], "sig")
    }

    func testBadStatusThrows() async {
        MockURLProtocol.handler = { req in
            (HTTPURLResponse(url: req.url!, statusCode: 403, httpVersion: nil, headerFields: nil)!, Data())
        }
        let client = ParticipantUploadClient(env: .echoNext, session: MockURLProtocol.makeSession())
        do {
            _ = try await client.initiate(projectId: "p1", name: "you", source: "GO_IOS")
            XCTFail("expected badStatus")
        } catch {
            XCTAssertEqual(error as? UploadError, .badStatus(403))
        }
    }

    // MARK: - helpers
    private static func ok(_ req: URLRequest) -> HTTPURLResponse {
        HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
    }
    private static func readJSON(_ stream: InputStream) -> [String: Any]? {
        stream.open(); defer { stream.close() }
        var data = Data(); let size = 4096; let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: size)
        defer { buf.deallocate() }
        while stream.hasBytesAvailable {
            let read = stream.read(buf, maxLength: size)
            if read <= 0 { break }
            data.append(buf, count: read)
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}
