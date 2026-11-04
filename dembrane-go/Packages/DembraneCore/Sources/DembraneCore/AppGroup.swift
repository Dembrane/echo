import Foundation

/// Shared container between the app and the Share Extension. The app writes the
/// active project + environment here so the extension can upload to the right
/// place via the public participant flow (no auth needed).
public enum AppGroup {
    public static let identifier = "group.com.dembrane.go"
    public static let selectedProjectIdKey = "dembrane.go.shared.selectedProjectId"
    public static let selectedProjectNameKey = "dembrane.go.shared.selectedProjectName"
    public static let environmentKey = "dembrane.go.shared.environment"
    public static let pendingRecordAtKey = "dembrane.go.shared.pendingRecordAt"
    public static let pendingRecordProjectKey = "dembrane.go.shared.pendingRecordProjectId"
    public static let aiConsentAtKey = "dembrane.go.shared.aiConsentAt"

    public static var defaults: UserDefaults? { UserDefaults(suiteName: identifier) }

    /// A pending "start recording" signal: whether one is fresh, and the optional
    /// destination project it targets (nil = default / current).
    public struct RecordSignal: Sendable, Equatable {
        public let fired: Bool
        public let targetProjectId: String?
    }

    /// The "Record into [project]" App Intent (widget tile / Action Button / Siri /
    /// Shortcuts) sets this; the app consumes it on launch/activation to begin
    /// capture into `targetProjectId` (nil = the current/default project).
    public static func signalStartRecording(targetProjectId: String? = nil) {
        guard let defaults else { return }
        defaults.set(Date().timeIntervalSince1970, forKey: pendingRecordAtKey)
        if let targetProjectId {
            defaults.set(targetProjectId, forKey: pendingRecordProjectKey)
        } else {
            defaults.removeObject(forKey: pendingRecordProjectKey)
        }
    }

    /// Returns a fresh (<30s) start-recording signal if one is pending, then clears
    /// it. `fired` is false when nothing recent is queued.
    public static func consumeStartRecordingSignal() -> RecordSignal {
        guard let defaults else { return RecordSignal(fired: false, targetProjectId: nil) }
        let at = defaults.double(forKey: pendingRecordAtKey)
        let target = defaults.string(forKey: pendingRecordProjectKey)
        guard at > 0 else { return RecordSignal(fired: false, targetProjectId: nil) }
        defaults.removeObject(forKey: pendingRecordAtKey)
        defaults.removeObject(forKey: pendingRecordProjectKey)
        let fresh = Date().timeIntervalSince1970 - at < 30
        return RecordSignal(fired: fresh, targetProjectId: fresh ? target : nil)
    }

    /// Called by the app whenever the active project / environment changes.
    public static func write(projectId: String?, projectName: String?, environment: AppEnvironment) {
        guard let defaults else { return }
        defaults.set(projectId, forKey: selectedProjectIdKey)
        defaults.set(projectName, forKey: selectedProjectNameKey)
        defaults.set(environment.rawValue, forKey: environmentKey)
    }

    /// When the person allowed their recordings to go to AI for transcription and
    /// analysis; nil before that, after they withdraw, and after sign-out. Shared so
    /// the Share Extension uploads only with the same permission.
    public static var aiConsentAt: Date? {
        get { defaults?.object(forKey: aiConsentAtKey) as? Date }
        set { defaults?.set(newValue, forKey: aiConsentAtKey) }
    }

    /// Drops what belongs to the signed-out account, so the widgets and the Share
    /// Extension stop offering its projects.
    public static func forgetAccount() {
        for key in [selectedProjectIdKey, selectedProjectNameKey, projectsKey, favoritesKey,
                    defaultProjectIdKey, pendingRecordAtKey, pendingRecordProjectKey] {
            defaults?.removeObject(forKey: key)
        }
    }

    public static func readProjectId() -> String? { defaults?.string(forKey: selectedProjectIdKey) }
    public static func readProjectName() -> String? { defaults?.string(forKey: selectedProjectNameKey) }

    // Cross-workspace project list, mirrored so the Share Extension can offer the
    // same destination picker as the app (it has no auth / API of its own).
    public static let projectsKey = "dembrane.go.shared.projects"
    public static func writeProjects(_ projects: [WorkspaceProject]) {
        guard let data = try? JSONEncoder().encode(projects) else { return }
        defaults?.set(data, forKey: projectsKey)
    }
    public static func readProjects() -> [WorkspaceProject] {
        guard let data = defaults?.data(forKey: projectsKey),
              let list = try? JSONDecoder().decode([WorkspaceProject].self, from: data) else { return [] }
        return list
    }
    /// The app's backend, for the Share Extension. A store build is production only,
    /// the same as the app.
    public static func readEnvironment() -> AppEnvironment {
        #if DEBUG
        AppEnvironment(rawValue: defaults?.string(forKey: environmentKey) ?? "") ?? .default
        #else
        .default
        #endif
    }

    // Favorite projects: an ordered list of project ids (excludes the default
    // "Go Recordings" project). The single source of truth for the Home shelf and
    // the Home Screen widget; the app owns the order and mirrors it here so the
    // widget can render the same favorites in the same order.
    public static let favoritesKey = "dembrane.go.shared.favoriteProjectIds"
    public static func writeFavorites(_ ids: [String]) {
        defaults?.set(ids, forKey: favoritesKey)
    }
    public static func readFavorites() -> [String] {
        defaults?.stringArray(forKey: favoritesKey) ?? []
    }

    // The default "Go Recordings" project id, so the widget's hero tile can target
    // it explicitly (rather than whatever happens to be the current selection).
    public static let defaultProjectIdKey = "dembrane.go.shared.defaultProjectId"
    public static func writeDefaultProjectId(_ id: String?) {
        defaults?.set(id, forKey: defaultProjectIdKey)
    }
    public static func readDefaultProjectId() -> String? {
        defaults?.string(forKey: defaultProjectIdKey)
    }
}
