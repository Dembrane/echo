import SwiftUI
import DembraneCore

struct ConversationsView: View {
    @Environment(AppModel.self) private var model
    @State private var showProjectPicker = false
    @State private var selected: Conversation?
    @State private var pendingDelete: Conversation?
    @State private var search = ""
    @State private var selectMode = false
    @State private var selectedIDs = Set<String>()
    @State private var showBulkDelete = false

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
            List(selection: $selectedIDs) {
                if !selectMode {
                    Section { projectSelector }
                }
                Section { content }
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(.compact)
            .environment(\.editMode, .constant(selectMode ? .active : .inactive))
            .searchable(text: $search, prompt: "Search conversations")
            .refreshable { await model.loadConversations() }
            .navigationTitle("Conversations")
            .toolbar { toolbarContent }
            .safeAreaInset(edge: .bottom) { if selectMode { selectionBar } }
            .sheet(isPresented: $showProjectPicker) {
                ProjectPicker { model.selectProject($0) }
            }
            .sheet(item: $selected) { ConversationDetailView(conversation: $0) }
            .confirmationDialog("Delete this conversation?",
                                isPresented: Binding(get: { pendingDelete != nil },
                                                     set: { if !$0 { pendingDelete = nil } }),
                                titleVisibility: .visible, presenting: pendingDelete) { conversation in
                Button("Delete", role: .destructive) {
                    Task { await model.deleteConversation(conversation) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("It'll be removed from this project. Audio is kept for a short grace period.")
            }
            .confirmationDialog("Delete \(selectedIDs.count) conversation\(selectedIDs.count == 1 ? "" : "s")?",
                                isPresented: $showBulkDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    let ids = selectedIDs
                    exitSelect()
                    Task { await model.deleteConversations(ids) }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        if selectMode {
            ToolbarItem(placement: .topBarLeading) { Button("Done") { exitSelect() } }
            ToolbarItem(placement: .topBarTrailing) {
                Button(selectedIDs.count == filtered.count ? "Deselect All" : "Select All") {
                    selectedIDs = selectedIDs.count == filtered.count ? [] : Set(filtered.map(\.id))
                }
            }
        } else if !model.conversations.isEmpty {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Select") { selectMode = true }
            }
        }
    }

    private var selectionBar: some View {
        HStack {
            Button { model.askAboutMany(selectedIDs); exitSelect() } label: {
                Label("Ask", systemImage: "sparkles")
            }
            .disabled(selectedIDs.isEmpty)
            Spacer()
            Text(selectedIDs.isEmpty ? "Select conversations" : "\(selectedIDs.count) selected")
                .font(.subheadline).foregroundStyle(.secondary)
            Spacer()
            Button(role: .destructive) { showBulkDelete = true } label: {
                Label("Delete", systemImage: "trash")
            }
            .disabled(selectedIDs.isEmpty)
            .tint(.red)
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private func exitSelect() {
        selectMode = false
        selectedIDs = []
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
                Image(systemName: "chevron.up.chevron.down").font(.subheadline).foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private var content: some View {
        if model.conversationsLoading && model.conversations.isEmpty {
            HStack { Spacer(); ProgressView(); Spacer() }.listRowSeparator(.hidden)
        } else if model.conversationsError && model.conversations.isEmpty {
            VStack(spacing: 8) {
                Label("Couldn't load", systemImage: "wifi.exclamationmark").font(.headline)
                Text("Check your connection and try again.").font(.caption).foregroundStyle(.secondary)
                Button("Retry") { Task { await model.loadConversations() } }
                    .buttonStyle(.borderedProminent).tint(BrandColor.royalBlue)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 24).listRowSeparator(.hidden)
        } else if model.conversations.isEmpty {
            Text("No conversations yet — tap Record to start.")
                .foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 24).listRowSeparator(.hidden)
        } else if filtered.isEmpty {
            Text("No matches for “\(search)”.")
                .foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 24).listRowSeparator(.hidden)
        } else {
            ForEach(filtered) { conversation in
                ConversationRow(conversation: conversation)
                    .tag(conversation.id)
                    .contentShape(Rectangle())
                    .onTapGesture { if !selectMode { selected = conversation } }
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
