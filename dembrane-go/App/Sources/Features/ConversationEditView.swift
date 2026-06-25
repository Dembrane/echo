import SwiftUI
import DembraneCore

/// Edit a conversation's name and summary — mirrors the web edit fields
/// (title / participant_name / summary) via PATCH /v2/bff/conversations/{id}.
struct ConversationEditView: View {
    let conversation: Conversation
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var participantName: String
    @State private var summary: String
    @State private var isSaving = false
    @State private var error: String?

    init(conversation: Conversation) {
        self.conversation = conversation
        _title = State(initialValue: conversation.title ?? "")
        _participantName = State(initialValue: conversation.participantName ?? "")
        _summary = State(initialValue: conversation.summary ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Participant name", text: $participantName)
                    TextField("Title", text: $title)
                }
                Section("Summary") {
                    TextField("Summary", text: $summary, axis: .vertical)
                        .lineLimit(3...12)
                }
                if let error {
                    Text(error).foregroundStyle(.red).font(.callout)
                }
            }
            .navigationTitle("Edit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .disabled(!hasChanges)
                    }
                }
            }
        }
    }

    private var hasChanges: Bool {
        title != (conversation.title ?? "")
            || participantName != (conversation.participantName ?? "")
            || summary != (conversation.summary ?? "")
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            try await model.updateConversation(
                id: conversation.id,
                title: title,
                participantName: participantName,
                summary: summary)
            dismiss()
        } catch {
            self.error = "Couldn't save changes. Please try again."
        }
    }
}

#Preview {
    ConversationEditView(conversation: Conversation.previews[0])
        .environment(AppModel.makeMock())
}
