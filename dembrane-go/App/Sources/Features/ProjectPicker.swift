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
    @State private var selectMode = false
    @State private var selection: Set<String> = []
    let onSelect: (WorkspaceProject) -> Void

    var body: some View {
        NavigationStack {
            List(filtered) { item in row(item) }
            .listStyle(.plain)
            .overlay {
                if searching { ProgressView() }
                else if !search.isEmpty && filtered.isEmpty {
                    ContentUnavailableView.search(text: search)
                }
            }
            .searchable(text: $search, prompt: "Search projects")
            .task(id: search) { await runSearch() }
            .navigationTitle(selectMode ? "Favorite projects" : "Choose project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .sheet(isPresented: $showNewProject) {
                NewProjectSheet { dismiss() }   // created + selected → close the picker too
            }
        }
    }

    @ViewBuilder
    private func row(_ item: WorkspaceProject) -> some View {
        let isDefault = model.isDefaultProject(item.project)
        HStack(spacing: 12) {
            if selectMode {
                let circleColor: Color = isDefault
                    ? Color(.tertiaryLabel)
                    : (selection.contains(item.id) ? BrandColor.royalBlue : Color(.secondaryLabel))
                Image(systemName: selection.contains(item.id) ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(circleColor)
            }
            Button {
                if selectMode {
                    guard !isDefault else { return }   // the default can't be favorited
                    if selection.contains(item.id) { selection.remove(item.id) } else { selection.insert(item.id) }
                } else {
                    onSelect(item)
                    dismiss()
                }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.project.name).foregroundStyle(.primary)
                    if !item.subtitle.isEmpty {
                        Text(item.subtitle).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if !selectMode {
                if item.project.id == model.selectedProject?.id {
                    Image(systemName: "checkmark").foregroundStyle(BrandColor.royalBlue)
                }
                if isDefault {
                    Text("Default")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(.quaternary, in: .capsule)
                } else {
                    Button { model.toggleFavorite(item) } label: {
                        Image(systemName: model.isFavorite(item.project.id) ? "heart.fill" : "heart")
                            .foregroundStyle(model.isFavorite(item.project.id) ? BrandColor.royalBlue : .secondary)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(model.isFavorite(item.project.id) ? "Unfavorite" : "Favorite")
                }
            }
        }
        .contextMenu {
            if isDefault {
                Label("Default project", systemImage: "star.fill")
            } else {
                Button { model.setDefaultProject(item) } label: {
                    Label("Set as default", systemImage: "star")
                }
                Button { model.toggleFavorite(item) } label: {
                    Label(model.isFavorite(item.project.id) ? "Unfavorite" : "Favorite",
                          systemImage: model.isFavorite(item.project.id) ? "heart.slash" : "heart")
                }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        if selectMode {
            ToolbarItem(placement: .cancellationAction) {
                Button("Done") { selectMode = false; selection = [] }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(selection.isEmpty ? "Favorite" : "Favorite (\(selection.count))") { favoriteSelected() }
                    .disabled(selection.isEmpty)
            }
        } else {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Select") { selectMode = true }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showNewProject = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New project")
            }
        }
    }

    private func favoriteSelected() {
        var seen = Set<String>()
        let known = (model.allProjects + serverResults).filter { seen.insert($0.id).inserted }
        model.favorite(known.filter { selection.contains($0.id) })
        selectMode = false
        selection = []
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
        guard !q.isEmpty else { return favoritesFirst(model.allProjects) }
        let local = model.allProjects.filter {
            $0.project.name.localizedCaseInsensitiveContains(q)
                || $0.subtitle.localizedCaseInsensitiveContains(q)
        }
        var seen = Set<String>()
        let merged = (local + serverResults).filter { seen.insert($0.project.id).inserted }
        return favoritesFirst(merged)
    }

    /// Float favorites to the top (in their saved order); everything else keeps
    /// its original order. Stable so non-favorites don't shuffle.
    private func favoritesFirst(_ list: [WorkspaceProject]) -> [WorkspaceProject] {
        let order = model.favoriteProjectIds
        func rank(_ wp: WorkspaceProject) -> Int { order.firstIndex(of: wp.project.id) ?? Int.max }
        return list.enumerated()
            .sorted { a, b in
                let ra = rank(a.element), rb = rank(b.element)
                return ra == rb ? a.offset < b.offset : ra < rb
            }
            .map(\.element)
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
