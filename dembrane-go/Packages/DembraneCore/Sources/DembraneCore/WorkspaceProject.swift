import Foundation

/// A project paired with the workspace it belongs to — for the flat,
/// cross-workspace project picker (workspace/org shown as the subtitle,
/// mirroring the web frontend's selector).
public struct WorkspaceProject: Identifiable, Sendable, Hashable {
    public let project: Project
    public let workspace: Workspace

    public init(project: Project, workspace: Workspace) {
        self.project = project
        self.workspace = workspace
    }

    public var id: String { project.id }

    /// e.g. "Acme / Marketing" (org / workspace).
    public var subtitle: String {
        [workspace.orgName, workspace.name]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " / ")
    }
}
