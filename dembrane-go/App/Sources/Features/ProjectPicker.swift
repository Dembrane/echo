import SwiftUI
import DembraneCore

/// Reusable picker: a flat, searchable list of projects across every workspace,
/// with the workspace/org as a subtitle. Used by Record, Conversations,
/// Settings, and Ask. Search hits the server too, so any project is findable —
/// not just the recent ones loaded into `allProjects`.
struct ProjectPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    @State private var serverResults: [WorkspaceProject] = []
    @State private var searching = false
    @State private var showNewProject = false
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
            .overlay {
                if searching { ProgressView() }
                else if !search.isEmpty && filtered.isEmpty {
                    ContentUnavailableView.search(text: search)
                }
            }
            .searchable(text: $search, prompt: "Search projects")
            .task(id: search) { await runSearch() }
            .navigationTitle("Choose project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showNewProject = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("New project")
                }
            }
            .sheet(isPresented: $showNewProject) {
                NewProjectSheet { dismiss() }   // created + selected → close the picker too
            }
        }
    }

    /// Debounced server-side search across workspaces, merged with local matches.
    private func runSearch() async {
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { serverResults = []; searching = false; return }
        try? await Task.sleep(for: .milliseconds(300))   // cancelled when `search` changes
        if Task.isCancelled { return }
        searching = true
        serverResults = await model.searchProjects(q)
        searching = false
    }

    private var filtered: [WorkspaceProject] {
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return model.allProjects }
        let local = model.allProjects.filter {
            $0.project.name.localizedCaseInsensitiveContains(q)
                || $0.subtitle.localizedCaseInsensitiveContains(q)
        }
        var seen = Set<String>()
        return (local + serverResults).filter { seen.insert($0.project.id).inserted }
    }
}

/// Create a project, choosing which workspace it lives in.
private struct NewProjectSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onCreated: () -> Void
    @State private var name = ""
    @State private var workspaceId = ""
    @State private var creating = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Project name") {
                    TextField("e.g. Product meetings", text: $name)
                }
                Section("Workspace") {
                    Picker("Workspace", selection: $workspaceId) {
                        ForEach(model.workspaces) { ws in Text(ws.name).tag(ws.id) }
                    }
                    .pickerStyle(.inline)
                }
            }
            .navigationTitle("New project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if creating {
                        ProgressView()
                    } else {
                        Button("Create") { create() }
                            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || workspaceId.isEmpty)
                    }
                }
            }
            .onAppear {
                if workspaceId.isEmpty {
                    workspaceId = model.workspaces.first(where: { $0.isDefault })?.id
                        ?? model.workspaces.first?.id ?? ""
                }
            }
        }
    }

    private func create() {
        guard let ws = model.workspaces.first(where: { $0.id == workspaceId }) else { return }
        let projectName = name
        Task {
            creating = true
            let ok = await model.createProject(name: projectName, in: ws)
            creating = false
            if ok { dismiss(); onCreated() }
        }
    }
}
