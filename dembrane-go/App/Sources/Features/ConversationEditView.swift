import SwiftUI
import DembraneCore

/// Edit a conversation — name, summary (with regenerate), and tags, all in one
/// native grouped form. Mirrors the web's edit modal + summary controls.
struct ConversationEditView: View {
    let conversation: Conversation
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var title: String
    @State private var participantName: String
    @State private var summary: String

    @State private var availableTags: [ProjectTag] = []
    @State private var selectedTagIds: Set<String> = []
    @State private var originalTagIds: Set<String> = []
    @State private var newTag = ""
    @State private var loadingTags = true

    @State private var isSaving = false
    @State private var regenerating = false
    @State private var error: String?

    init(conversation: Conversation) {
        self.conversation = conversation
        _title = State(initialValue: conversation.title ?? "")
        _participantName = State(initialValue: conversation.participantName ?? "")
        _summary = State(initialValue: conversation.summary ?? "")
    }

    private var projectId: String { conversation.projectId ?? model.selectedProject?.id ?? "" }
    private var newTagTrimmed: String { newTag.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var hasChanges: Bool {
        title != (conversation.title ?? "")
            || participantName != (conversation.participantName ?? "")
            || summary != (conversation.summary ?? "")
            || selectedTagIds != originalTagIds
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Participant name", text: $participantName)
                        .textInputAutocapitalization(.words)
                    TextField("Title", text: $title)
                }

                Section {
                    TextField("Summary", text: $summary, axis: .vertical)
                        .lineLimit(4...18)
                    Button {
                        regenerate()
                    } label: {
                        if regenerating {
                            HStack { ProgressView(); Text("Regenerating…") }
                        } else {
                            Label("Regenerate summary", systemImage: "sparkles")
                        }
                    }
                    .disabled(regenerating || isSaving)
                } header: {
                    Text("Summary")
                } footer: {
                    Text("Regenerate rewrites the summary from the transcript.")
                }

                Section("Tags") {
                    if loadingTags {
                        HStack { Spacer(); ProgressView(); Spacer() }
                    } else {
                        ForEach(availableTags) { tag in
                            Button { toggleTag(tag.id) } label: {
                                HStack {
                                    Text(tag.text).foregroundStyle(.primary)
                                    Spacer()
                                    if selectedTagIds.contains(tag.id) {
                                        Image(systemName: "checkmark").foregroundStyle(BrandColor.royalBlue)
                                    }
                                }
                            }
                        }
                        HStack {
                            TextField("New tag", text: $newTag)
                                .autocorrectionDisabled()
                                .onSubmit { addTag() }
                            Button("Add") { addTag() }.disabled(newTagTrimmed.isEmpty)
                        }
                    }
                }

                if let error {
                    Text(error).foregroundStyle(.red).font(.callout)
                }
            }
            .navigationTitle("Edit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving { ProgressView() }
                    else { Button("Save") { save() }.disabled(!hasChanges) }
                }
            }
            .task { await loadTags() }
        }
    }

    private func loadTags() async {
        availableTags = (try? await model.projectTags(projectId: projectId)) ?? []
        let current = Set(((try? await model.conversationTags(conversation.id)) ?? []).map(\.id))
        selectedTagIds = current
        originalTagIds = current
        loadingTags = false
    }

    private func toggleTag(_ id: String) {
        if selectedTagIds.contains(id) { selectedTagIds.remove(id) } else { selectedTagIds.insert(id) }
    }

    private func addTag() {
        let text = newTagTrimmed
        guard !text.isEmpty else { return }
        Task {
            if let tag = try? await model.createTag(projectId: projectId, text: text) {
                if !availableTags.contains(where: { $0.id == tag.id }) { availableTags.insert(tag, at: 0) }
                selectedTagIds.insert(tag.id)
                newTag = ""
            }
        }
    }

    private func regenerate() {
        Task {
            regenerating = true
            defer { regenerating = false }
            try? await model.summarizeConversation(conversation.id)
            if let updated = try? await model.conversationDetail(id: conversation.id) {
                summary = updated.summary ?? summary
            }
        }
    }

    private func save() {
        Task {
            isSaving = true
            defer { isSaving = false }
            do {
                try await model.updateConversation(
                    id: conversation.id, title: title,
                    participantName: participantName, summary: summary)
                if selectedTagIds != originalTagIds {
                    try await model.setConversationTags(conversation.id, tagIds: Array(selectedTagIds))
                }
                dismiss()
            } catch {
                self.error = "Couldn't save changes. Try again."
            }
        }
    }
}

#Preview {
    ConversationEditView(conversation: Conversation.previews[0])
        .environment(AppModel.makeMock())
}
