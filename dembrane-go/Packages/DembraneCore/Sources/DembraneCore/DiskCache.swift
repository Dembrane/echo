import Foundation

/// A tiny JSON disk cache so list screens (conversations, projects, chats) show
/// instantly from the last fetch, then reconcile with the network. Plain codec
/// (camelCase round-trip) — independent of the API's snake_case decoder.
public actor DiskCache {
    public static let shared = DiskCache()

    private let dir: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init() {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        dir = base.appendingPathComponent("dembrane-go-cache", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    public func load<T: Decodable & Sendable>(_ type: T.Type, key: String) -> T? {
        guard let data = try? Data(contentsOf: url(for: key)) else { return nil }
        return try? decoder.decode(T.self, from: data)
    }

    public func save<T: Encodable & Sendable>(_ value: T, key: String) {
        guard let data = try? encoder.encode(value) else { return }
        try? data.write(to: url(for: key), options: .atomic)
    }

    private func url(for key: String) -> URL {
        dir.appendingPathComponent(key.replacingOccurrences(of: "/", with: "_") + ".json")
    }
}
