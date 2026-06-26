import AppIntents
import DembraneCore

/// Starts a recording from the Action Button, Siri, Spotlight, Control Center,
/// or the Shortcuts app — the most "Apple" way to expose the app's primary
/// action. It foregrounds the app (openAppWhenRun) and drops a shared signal;
/// the app begins capture as soon as it's active and a project is loaded.
struct StartRecordingIntent: AppIntent {
    static var title: LocalizedStringResource = "Start Recording"
    static var description = IntentDescription("Start a new dembrane Go recording.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        AppGroup.signalStartRecording()
        return .result()
    }
}

/// Makes "Start Recording" discoverable in Siri/Spotlight/Shortcuts with zero
/// setup, and assignable to the Action Button.
struct DembraneGoShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartRecordingIntent(),
            phrases: [
                "Start a \(.applicationName) recording",
                "Record with \(.applicationName)",
                "New \(.applicationName) recording",
            ],
            shortTitle: "Start Recording",
            systemImageName: "mic.fill"
        )
    }
}
