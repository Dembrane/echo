import AppIntents
import DembraneCore

/// Makes the record actions discoverable in Siri / Spotlight / Shortcuts with
/// zero setup, and assignable to the Action Button. The intents themselves live
/// in DembraneCore so the widget extension can reuse them.
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
        AppShortcut(
            intent: RecordIntoProjectIntent(),
            phrases: [
                "Record into a \(.applicationName) project",
                "\(.applicationName) record into project",
            ],
            shortTitle: "Record into project",
            systemImageName: "mic.badge.plus"
        )
    }
}
