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
            List {
                // Scrolls with the content (not a sticky bar) so the large title
                // fades and the tab bar collapses naturally on scroll.
                Section {
                    projectSelector
                }
                Section {
                    content
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $search, prompt: "Search conversations")
            .refreshable { await model.loadConversations() }
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

    private var projectSelector: some View {
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
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private var content: some View {
        if model.conversationsLoading && model.conversations.isEmpty {
            HStack { Spacer(); ProgressView(); Spacer() }
                .listRowSeparator(.hidden)
        } else if model.conversationsError && model.conversations.isEmpty {
            VStack(spacing: 8) {
                Label("Couldn't load", systemImage: "wifi.exclamationmark")
                    .font(.headline)
                Text("Check your connection and try again.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Retry") { Task { await model.loadConversations() } }
                    .buttonStyle(.borderedProminent).tint(BrandColor.royalBlue)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
            .listRowSeparator(.hidden)
        } else if model.conversations.isEmpty {
            Text("No conversations yet — tap Record to start.")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 24)
                .listRowSeparator(.hidden)
        } else if filtered.isEmpty {
            Text("No matches for “\(search)”.")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 24)
                .listRowSeparator(.hidden)
        } else {
            ForEach(filtered) { conversation in
                Button { selected = conversation } label: {
                    ConversationRow(conversation: conversation)
                }
                .buttonStyle(.plain)
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(role: .destructive) { pendingDelete = conversation } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    Button { model.askAbout(conversation) } label: {
                        Label("Ask", systemImage: "sparkles")
                    }
                    .tint(BrandColor.royalBlue)
                }
            }
        }
    }

    private var selectedWorkspaceName: String? {
        guard let id = model.selectedProject?.id else { return nil }
        return model.allProjects.first { $0.project.id == id }?.workspace.name
    }
}

#Preview {
    ConversationsView().environment(AppModel.makeMock())
}
