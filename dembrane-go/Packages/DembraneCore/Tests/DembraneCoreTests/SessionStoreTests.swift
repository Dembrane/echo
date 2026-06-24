import XCTest
@testable import DembraneCore

final class SessionStoreTests: XCTestCase {
    func testInMemorySaveLoadClear() throws {
        let store = InMemorySessionStore()
        XCTAssertNil(store.load())
        try store.save(token: "abc123")
        XCTAssertEqual(store.load(), "abc123")
        try store.save(token: "def456")
        XCTAssertEqual(store.load(), "def456")
        try store.clear()
        XCTAssertNil(store.load())
    }

    func testInMemorySeededInit() {
        XCTAssertEqual(InMemorySessionStore(token: "seed").load(), "seed")
    }
}
