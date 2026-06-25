import SwiftUI
import DembraneCore

struct ConversationsView: View {
    @Environment(AppModel.self) private var model
    @State private var showProjectPicker = false
    @State private var selected: Conversation?
    @State private var pendingDelete: Conversation?
    @State private var search = ""

    private var filtered: [Conversation] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return model.conversations }
        return model.conversations.filter {
            $0.displayTitle.localizedCaseInsensitiveContains(query)
                || ($0.summary?.localizedCaseInsensitiveContains(query) ?? false)
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                projectHeader
                Divider()
                list
            }
            .navigationTitle("Conversations")
            .sheet(isPresented: $showProjectPicker) {
                ProjectPicker { model.selectProject($0) }
            }
            .sheet(item: $selected) { conversation in
                ConversationDetailView(conversation: conversation)
            }
            .confirmationDialog(
                "Delete this conversation?",
                isPresented: Binding(get: { pendingDelete != nil },
                                     set: { if !$0 { pendingDelete = nil } }),
                titleVisibility: .visible,
                presenting: pendingDelete
            ) { conversation in
                Button("Delete", role: .destructive) {
                    Task { await model.deleteConversation(conversation) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("It'll be removed from this project. Audio is kept for a short grace period.")
            }
        }
    }

    /// Full-width selected-project header (project name + workspace), tappable.
    private var projectHeader: some View {
        Button { showProjectPicker = true } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Selected project").font(.caption).foregroundStyle(.secondary)
                    Text(model.selectedProject?.name ?? "Choose a project")
                        .font(.headline).foregroundStyle(.primary).lineLimit(1)
                    if let workspace = selectedWorkspaceName {
                        Text(workspace).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer()
                Image(systemName: "chevron.up.chevron.down")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            .padding(.horizontal)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var selectedWorkspaceName: String? {
        guard let id = model.selectedProject?.id else { return nil }
        return model.allProjects.first { $0.project.id == id }?.workspace.name
    }

    private var list: some View {
        List {
            ForEach(filtered) { conversation in
                Button {
                    selected = conversation
                } label: {
                    ConversationRow(conversation: conversation)
                }
                .buttonStyle(.plain)
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(role: .destructive) {
                        pendingDelete = conversation
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    Button {
                        model.askAbout(conversation)
                    } label: {
                        Label("Ask", systemImage: "sparkles")
                    }
                    .tint(BrandColor.royalBlue)
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if model.conversationsLoading && model.conversations.isEmpty {
                ProgressView()
            } else if model.conversationsError && model.conversations.isEmpty {
                ContentUnavailableView {
                    Label("Couldn't load", systemImage: "wifi.exclamationmark")
                } description: {
                    Text("Check your connection and try again.")
                } actions: {
                    Button("Retry") { Task { await model.loadConversations() } }
                        .buttonStyle(.borderedProminent).tint(BrandColor.royalBlue)
                }
            } else if model.conversations.isEmpty {
                ContentUnavailableView {
                    Label("No conversations yet", systemImage: "waveform")
                } description: {
                    Text("Start your first one.")
                }
            } else if filtered.isEmpty {
                ContentUnavailableView.search(text: search)
            }
        }
        .searchable(text: $search, prompt: "Search conversations")
        .refreshable { await model.loadConversations() }
    }
}

#Preview {
    ConversationsView().environment(AppModel.makeMock())
}
