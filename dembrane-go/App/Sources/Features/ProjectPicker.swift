import SwiftUI
import DembraneCore

/// Reusable picker: a flat, searchable list of projects across every workspace,
/// with the workspace/org as a subtitle. Used by Record, Conversations,
/// Settings, and Ask.
struct ProjectPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    @State private var showNewProject = false
    @State private var newProjectName = ""
    @State private var creating = false
    let onSelect: (WorkspaceProject) -> Void

    var body: some View {
        NavigationStack {
            List(filtered) { item in
                Button {
                    onSelect(item)
                    dismiss()
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.project.name).foregroundStyle(.primary)
                            if !item.subtitle.isEmpty {
                                Text(item.subtitle).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        if item.project.id == model.selectedProject?.id {
                            Image(systemName: "checkmark").foregroundStyle(BrandColor.royalBlue)
                        }
                    }
                }
            }
            .listStyle(.plain)
            .searchable(text: $search, prompt: "Search projects")
            .navigationTitle("Choose project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showNewProject = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("New project")
                }
            }
            .alert("New project", isPresented: $showNewProject) {
                TextField("Project name", text: $newProjectName)
                Button("Cancel", role: .cancel) { newProjectName = "" }
                Button("Create") {
                    let name = newProjectName
                    newProjectName = ""
                    Task {
                        creating = true
                        if await model.createProject(name: name) { dismiss() }
                        creating = false
                    }
                }
            } message: {
                Text("Recordings and chats live inside a project.")
            }
        }
    }

    private var filtered: [WorkspaceProject] {
        guard !search.isEmpty else { return model.allProjects }
        return model.allProjects.filter {
            $0.project.name.localizedCaseInsensitiveContains(search)
                || $0.subtitle.localizedCaseInsensitiveContains(search)
        }
    }
}
