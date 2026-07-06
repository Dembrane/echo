import SwiftUI
import DembraneCore

/// Assign tags to a conversation: toggle from the project's tags, or add a new
/// one. Saves via replace (POST /v2/bff/conversation-project-tags/replace).
struct ConversationTagsView: View {
    let conversation: Conversation
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var available: [ProjectTag] = []
    @State private var selected: Set<String> = []
    @State private var newTag = ""
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?

    private var projectId: String {
        conversation.projectId ?? model.selectedProject?.id ?? ""
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        TextField("New tag", text: $newTag)
                            .autocorrectionDisabled()
                            .onSubmit { Task { await addTag() } }
                        Button("Add") { Task { await addTag() } }
                            .disabled(trimmedNew.isEmpty || saving)
                    }
                }
                Section("Tags") {
                    if loading {
                        ProgressView()
                    } else if available.isEmpty {
                        Text("No tags yet. Add one above.").foregroundStyle(.secondary)
                    } else {
                        ForEach(available) { tag in
                            Button { toggle(tag.id) } label: {
                                HStack {
                                    Text(tag.text).foregroundStyle(.primary)
                                    Spacer()
                                    if selected.contains(tag.id) {
                                        Image(systemName: "checkmark").foregroundStyle(BrandColor.royalBlue)
                                    }
                                }
                            }
                        }
                    }
                }
                if let error {
                    Text(error).foregroundStyle(.red).font(.callout)
                }
            }
            .navigationTitle("Tags")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView() }
                    else { Button("Save") { Task { await save() } } }
                }
            }
            .task { await load() }
        }
    }

    private var trimmedNew: String { newTag.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func load() async {
        available = (try? await model.projectTags(projectId: projectId)) ?? []
        selected = Set(((try? await model.conversationTags(conversation.id)) ?? []).map(\.id))
        loading = false
    }

    private func toggle(_ id: String) {
        if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
    }

    private func addTag() async {
        let text = trimmedNew
        guard !text.isEmpty, !saving else { return }
        saving = true
        defer { saving = false }
        do {
            let tag = try await model.createTag(projectId: projectId, text: text)
            if !available.contains(where: { $0.id == tag.id }) { available.insert(tag, at: 0) }
            selected.insert(tag.id)
            newTag = ""
        } catch {
            self.error = "Couldn't add that tag."
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            try await model.setConversationTags(conversation.id, tagIds: Array(selected))
            dismiss()
        } catch {
            self.error = "Couldn't save tags. Try again."
        }
    }
}

#Preview {
    ConversationTagsView(conversation: Conversation.previews[0])
        .environment(AppModel.makeMock())
}
