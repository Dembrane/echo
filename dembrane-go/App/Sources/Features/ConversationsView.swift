import SwiftUI
import DembraneCore
#if canImport(UIKit)
import UIKit
#endif

struct ConversationsView: View {
    @Environment(AppModel.self) private var model
    @State private var showProjectPicker = false
    @State private var selected: Conversation?
    @State private var pendingDelete: Conversation?
    @State private var search = ""
    @State private var selectMode = false
    @State private var selectedIDs = Set<String>()
    @State private var showBulkDelete = false
    @State private var showBulkTag = false
    @State private var deleteTick = 0

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
                    deleteTick += 1
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
                    deleteTick += 1
                    exitSelect()
                    Task { await model.deleteConversations(ids) }
                }
                Button("Cancel", role: .cancel) {}
            }
            .sheet(isPresented: $showBulkTag) {
                BulkTagPicker(conversationIds: selectedIDs) { exitSelect() }
            }
            // Selection tick entering/leaving multi-select; success cue on a confirmed delete.
            .sensoryFeedback(.selection, trigger: selectMode)
            .sensoryFeedback(.success, trigger: deleteTick)
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
        HStack(spacing: 24) {
            Button { model.askAboutMany(selectedIDs); exitSelect() } label: {
                Image(systemName: "sparkles").font(.title3)
            }
            .accessibilityLabel("Ask about selected")
            ShareLink(item: selectedShareText) {
                Image(systemName: "square.and.arrow.up").font(.title3)
            }
            Button { showBulkTag = true } label: {
                Image(systemName: "tag").font(.title3)
            }
            .accessibilityLabel("Tag selected")
            Spacer()
            Text(selectedIDs.isEmpty ? "Select conversations" : "\(selectedIDs.count) selected")
                .font(.subheadline).foregroundStyle(.secondary)
            Spacer()
            Button(role: .destructive) { showBulkDelete = true } label: {
                Image(systemName: "trash").font(.title3)
            }
            .tint(.red)
            .accessibilityLabel("Delete selected")
        }
        .disabled(selectedIDs.isEmpty)
        .tint(BrandColor.royalBlue)
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var selectedShareText: String {
        filtered.filter { selectedIDs.contains($0.id) }
            .map(shareText)
            .joined(separator: "\n\n———\n\n")
    }

    private func shareText(_ conversation: Conversation) -> String {
        if let summary = conversation.summary?.trimmingCharacters(in: .whitespacesAndNewlines),
           !summary.isEmpty {
            return "\(conversation.displayTitle)\n\n\(summary)"
        }
        return conversation.displayTitle
    }

    private func copyTranscript(_ conversation: Conversation) {
        Task {
            let chunks = (try? await model.conversationChunks(id: conversation.id)) ?? []
            let transcript = chunks
                .sorted { ($0.timestamp ?? .distantPast) < ($1.timestamp ?? .distantPast) }
                .compactMap { $0.transcript?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .joined(separator: " ")
            let text = transcript.isEmpty ? (conversation.summary ?? conversation.displayTitle) : transcript
            #if canImport(UIKit)
            UIPasteboard.general.string = text
            #endif
        }
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
                    .contextMenu {
                        Button { model.askAbout(conversation) } label: {
                            Label("Ask", systemImage: "sparkles")
                        }
                        ShareLink(item: shareText(conversation)) {
                            Label("Share", systemImage: "square.and.arrow.up")
                        }
                        Button { copyTranscript(conversation) } label: {
                            Label("Copy transcript", systemImage: "doc.on.doc")
                        }
                        Button(role: .destructive) { pendingDelete = conversation } label: {
                            Label("Delete", systemImage: "trash")
                        }
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

/// Pick tags to add to several selected conversations (bulk-tag).
private struct BulkTagPicker: View {
    let conversationIds: Set<String>
    let onApply: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var tags: [ProjectTag] = []
    @State private var picked = Set<String>()
    @State private var newTag = ""
    @State private var loading = true
    @State private var applying = false

    private var projectId: String { model.selectedProject?.id ?? "" }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        TextField("New tag", text: $newTag).autocorrectionDisabled()
                        Button("Add") { Task { await addTag() } }
                            .disabled(newTag.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
                Section {
                    if loading { HStack { Spacer(); ProgressView(); Spacer() } }
                    else if tags.isEmpty { Text("No tags yet — add one above.").foregroundStyle(.secondary) }
                    else {
                        ForEach(tags) { tag in
                            Button { toggle(tag.id) } label: {
                                HStack {
                                    Text(tag.text).foregroundStyle(.primary)
                                    Spacer()
                                    if picked.contains(tag.id) {
                                        Image(systemName: "checkmark").foregroundStyle(BrandColor.royalBlue)
                                    }
                                }
                            }
                        }
                    }
                } footer: {
                    Text("Adds the selected tags to \(conversationIds.count) conversation\(conversationIds.count == 1 ? "" : "s").")
                }
            }
            .navigationTitle("Add tags")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if applying { ProgressView() }
                    else {
                        Button("Apply") {
                            Task {
                                applying = true
                                await model.addTags(picked, to: conversationIds)
                                applying = false
                                onApply()
                                dismiss()
                            }
                        }
                        .disabled(picked.isEmpty)
                    }
                }
            }
            .task {
                tags = (try? await model.projectTags(projectId: projectId)) ?? []
                loading = false
            }
        }
    }

    private func toggle(_ id: String) {
        if picked.contains(id) { picked.remove(id) } else { picked.insert(id) }
    }

    private func addTag() async {
        let text = newTag.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if let tag = try? await model.createTag(projectId: projectId, text: text) {
            if !tags.contains(where: { $0.id == tag.id }) { tags.insert(tag, at: 0) }
            picked.insert(tag.id)
            newTag = ""
        }
    }
}
