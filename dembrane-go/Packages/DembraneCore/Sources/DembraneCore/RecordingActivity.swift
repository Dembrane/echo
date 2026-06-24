#if canImport(ActivityKit)
import ActivityKit
import Foundation

/// Live Activity attributes for an in-progress recording (Dynamic Island + Lock
/// Screen). Shared by the app (starts/updates/ends it) and the widget extension
/// (renders it). `startedAt` lets the widget show a live timer with no pushes.
public struct RecordingActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        public var startedAt: Date
        public var projectName: String
        public init(startedAt: Date, projectName: String) {
            self.startedAt = startedAt
            self.projectName = projectName
        }
    }
    public init() {}
}
#endif
