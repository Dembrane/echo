#if os(iOS)
import ActivityKit
import Foundation

/// Live Activity attributes for an in-progress recording (Dynamic Island + Lock
/// Screen). Shared by the app (starts/updates/ends it) and the widget extension
/// (renders it). `startedAt` lets the widget show a live timer with no pushes.
public struct RecordingActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// Effective start: `Date() - startedAt` is the live elapsed, so the widget's
        /// self-running timer reads correctly across pauses.
        public var startedAt: Date
        public var projectName: String
        public var isPaused: Bool
        /// Frozen elapsed shown while paused (a running timer can't pause itself).
        public var elapsed: TimeInterval
        public init(startedAt: Date, projectName: String,
                    isPaused: Bool = false, elapsed: TimeInterval = 0) {
            self.startedAt = startedAt
            self.projectName = projectName
            self.isPaused = isPaused
            self.elapsed = elapsed
        }
    }
    public init() {}
}
#endif
