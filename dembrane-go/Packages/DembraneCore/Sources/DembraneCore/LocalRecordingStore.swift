import Foundation

/// Metadata for a locally-captured recording. Persisted as meta.json next to the
/// segment files so a recording survives an app kill / force-quit and can be
/// pushed to dembrane later. Audio lives on disk until it's fully uploaded.
public struct LocalRecording: Codable, Identifiable, Sendable, Equatable {
    public var id: String                 // local UUID == folder name
    public var conversationId: String?    // server id once the conversation exists
    public var projectId: String
    public var displayName: String
    public var createdAt: Date
    public var segmentCount: Int          // highest segment index + 1 we've seen
    public var uploadedSegments: [Int]    // segment indices confirmed uploaded
    public var isFinished: Bool           // user stopped (vs. killed mid-recording)
    public var durationSeconds: Double
}

/// On-device store for recording segments + their upload state. Files are kept
/// until a recording is fully pushed, then removed. Survives relaunch.
public actor LocalRecordingStore {
    public static let shared = LocalRecordingStore()

    private let fm = FileManager.default

    private var baseDir: URL {
        let dir = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DembraneGo/Recordings", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
    private func folder(_ id: String) -> URL { baseDir.appendingPathComponent(id, isDirectory: true) }
    private func metaURL(_ id: String) -> URL { folder(id).appendingPathComponent("meta.json") }

    /// The recording's folder (created if needed) — the recorder writes segments here.
    public func directoryURL(_ id: String) -> URL {
        let f = folder(id)
        try? fm.createDirectory(at: f, withIntermediateDirectories: true)
        return f
    }

    /// Where the recorder should write segment `index` for recording `id`.
    public func segmentURL(_ id: String, index: Int) -> URL {
        folder(id).appendingPathComponent(String(format: "seg-%04d.m4a", index))
    }

    private func loadMeta(_ id: String) -> LocalRecording? {
        guard let data = try? Data(contentsOf: metaURL(id)) else { return nil }
        return try? JSONDecoder().decode(LocalRecording.self, from: data)
    }
    private func saveMeta(_ rec: LocalRecording) {
        try? fm.createDirectory(at: folder(rec.id), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(rec) { try? data.write(to: metaURL(rec.id)) }
    }

    @discardableResult
    public func begin(projectId: String, displayName: String, createdAt: Date) -> LocalRecording {
        let rec = LocalRecording(
            id: UUID().uuidString, conversationId: nil, projectId: projectId,
            displayName: displayName, createdAt: createdAt, segmentCount: 0,
            uploadedSegments: [], isFinished: false, durationSeconds: 0)
        saveMeta(rec)
        return rec
    }

    public func noteSegment(_ id: String, index: Int) {
        guard var rec = loadMeta(id) else { return }
        rec.segmentCount = max(rec.segmentCount, index + 1)
        saveMeta(rec)
    }
    public func markUploaded(_ id: String, index: Int) {
        guard var rec = loadMeta(id) else { return }
        if !rec.uploadedSegments.contains(index) { rec.uploadedSegments.append(index) }
        saveMeta(rec)
    }
    public func setConversationId(_ id: String, _ conversationId: String) {
        guard var rec = loadMeta(id) else { return }
        rec.conversationId = conversationId
        saveMeta(rec)
    }
    public func setName(_ id: String, _ name: String) {
        guard var rec = loadMeta(id) else { return }
        rec.displayName = name
        saveMeta(rec)
    }
    public func finish(_ id: String, duration: Double) {
        guard var rec = loadMeta(id) else { return }
        rec.isFinished = true
        rec.durationSeconds = duration
        saveMeta(rec)
    }

    /// Remove a recording's local audio + metadata (after a full upload, or discard).
    public func remove(_ id: String) { try? fm.removeItem(at: folder(id)) }

    public func get(_ id: String) -> LocalRecording? { loadMeta(id) }

    /// All recordings still on disk, newest first.
    public func all() -> [LocalRecording] {
        let entries = (try? fm.contentsOfDirectory(at: baseDir, includingPropertiesForKeys: nil)) ?? []
        return entries.compactMap { loadMeta($0.lastPathComponent) }
            .sorted { $0.createdAt > $1.createdAt }
    }

    /// Segment files actually present on disk (source of truth for re-upload),
    /// ordered by index.
    public func segmentFiles(_ id: String) -> [(index: Int, url: URL)] {
        let files = (try? fm.contentsOfDirectory(at: folder(id), includingPropertiesForKeys: nil)) ?? []
        return files.compactMap { url -> (Int, URL)? in
            let name = url.deletingPathExtension().lastPathComponent
            guard name.hasPrefix("seg-"), let idx = Int(name.dropFirst(4)) else { return nil }
            return (idx, url)
        }.sorted { $0.0 < $1.0 }
    }
}
