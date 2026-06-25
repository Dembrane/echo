import Foundation

/// Shared container between the app and the Share Extension. The app writes the
/// active project + environment here so the extension can upload to the right
/// place via the public participant flow (no auth needed).
public enum AppGroup {
    public static let identifier = "group.com.dembrane.go"
    public static let selectedProjectIdKey = "dembrane.go.shared.selectedProjectId"
    public static let environmentKey = "dembrane.go.shared.environment"
    public static let pendingRecordAtKey = "dembrane.go.shared.pendingRecordAt"

    public static var defaults: UserDefaults? { UserDefaults(suiteName: identifier) }

    /// The "Start Recording" App Intent (Action Button / Siri / Shortcuts) sets this;
    /// the app consumes it on launch/activation to begin capture.
    public static func signalStartRecording() {
        defaults?.set(Date().timeIntervalSince1970, forKey: pendingRecordAtKey)
    }

    /// True once if a recent (<30s) start-recording signal is pending; clears it.
    public static func consumeStartRecordingSignal() -> Bool {
        guard let defaults else { return false }
        let at = defaults.double(forKey: pendingRecordAtKey)
        guard at > 0 else { return false }
        defaults.removeObject(forKey: pendingRecordAtKey)
        return Date().timeIntervalSince1970 - at < 30
    }

    /// Called by the app whenever the active project / environment changes.
    public static func write(projectId: String?, environment: AppEnvironment) {
        guard let defaults else { return }
        defaults.set(projectId, forKey: selectedProjectIdKey)
        defaults.set(environment.rawValue, forKey: environmentKey)
    }

    public static func readProjectId() -> String? { defaults?.string(forKey: selectedProjectIdKey) }
    public static func readEnvironment() -> AppEnvironment {
        AppEnvironment(rawValue: defaults?.string(forKey: environmentKey) ?? "") ?? .default
    }
}
