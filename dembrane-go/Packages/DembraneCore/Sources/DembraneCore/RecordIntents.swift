import AppIntents
import Foundation

/// A project the user can record into, surfaced to Siri / Shortcuts / widgets.
/// Backed by the project list the app mirrors into the App Group, so it resolves
/// without auth or a network call from the extension / system process. Lives in
/// DembraneCore so both the app and the widget extension can use it.
public struct ProjectEntity: AppEntity, Identifiable {
    public let id: String
    public let name: String
    public let subtitle: String

    public init(id: String, name: String, subtitle: String) {
        self.id = id
        self.name = name
        self.subtitle = subtitle
    }

    public static var typeDisplayRepresentation: TypeDisplayRepresentation { "Project" }
    public var displayRepresentation: DisplayRepresentation {
        subtitle.isEmpty
            ? DisplayRepresentation(title: "\(name)")
            : DisplayRepresentation(title: "\(name)", subtitle: "\(subtitle)")
    }
    public static var defaultQuery = ProjectEntityQuery()
}

public struct ProjectEntityQuery: EntityQuery {
    public init() {}
    public func entities(for identifiers: [String]) async throws -> [ProjectEntity] {
        AppGroup.readProjects()
            .filter { identifiers.contains($0.project.id) }
            .map { ProjectEntity(id: $0.project.id, name: $0.project.name, subtitle: $0.subtitle) }
    }
    public func suggestedEntities() async throws -> [ProjectEntity] {
        AppGroup.readProjects()
            .map { ProjectEntity(id: $0.project.id, name: $0.project.name, subtitle: $0.subtitle) }
    }
}

/// The single record action behind the favorite cards, the widget tiles, the
/// Action Button, Siri, Spotlight, Control Center, and Shortcuts. It foregrounds
/// the app (openAppWhenRun) and drops a shared signal carrying the destination;
/// the app begins capture into that project as soon as it's active. With no
/// project it records into the default ("Go Recordings") / current project.
public struct RecordIntoProjectIntent: AppIntent {
    public static var title: LocalizedStringResource = "Record into project"
    public static var description = IntentDescription("Start a dembrane Go recording into a project.")
    public static var openAppWhenRun = true

    @Parameter(title: "Project")
    public var project: ProjectEntity?

    public init() {}
    public init(project: ProjectEntity?) { self.project = project }

    @MainActor
    public func perform() async throws -> some IntentResult {
        AppGroup.signalStartRecording(targetProjectId: project?.id)
        return .result()
    }

    public static var parameterSummary: some ParameterSummary {
        Summary("Record into \(\.$project)")
    }
}

/// Records into the default project / current selection — the parameterless
/// action for the Action Button and a plain "start a recording" phrase.
public struct StartRecordingIntent: AppIntent {
    public static var title: LocalizedStringResource = "Start Recording"
    public static var description = IntentDescription("Start a new dembrane Go recording.")
    public static var openAppWhenRun = true

    public init() {}

    @MainActor
    public func perform() async throws -> some IntentResult {
        AppGroup.signalStartRecording(targetProjectId: nil)
        return .result()
    }
}
