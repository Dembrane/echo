import SwiftUI
import DembraneCore

/// Chat with your conversations. Specific-context mode: pick conversations to
/// focus on (or leave empty to ask across the whole project), then stream.
struct AskView: View {
    @Environment(AppModel.self) private var model
    @State private var input = ""
    @State private var showContextPicker = false
    @State private var showHistory = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                contextBar
                Divider()
                content
                inputBar
            }
            .navigationTitle("Ask")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showHistory = true } label: {
                        Image(systemName: "clock.arrow.circlepath")
                    }
                    .accessibilityLabel("Chat history")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { model.resetAskThread() } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .disabled(model.askMessages.isEmpty)
                    .accessibilityLabel("New chat")
                }
            }
            .sheet(isPresented: $showContextPicker) { AskContextPicker() }
            .sheet(isPresented: $showHistory) { AskHistoryView() }
            .onAppear { model.startAskForPending() }
        }
    }

    private var contextConversations: [Conversation] {
        model.conversations.filter { model.askConversationIds.contains($0.id) }
    }

    private var contextBar: some View {
        Button { showContextPicker = true } label: {
            HStack(spacing: 8) {
                Image(systemName: "text.bubble")
                Text(contextLabel).lineLimit(1)
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
            .font(.subheadline)
            .padding(.horizontal)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
    }

    private var contextLabel: String {
        let names = contextConversations.map(\.displayTitle)
        switch names.count {
        case 0: return "All of \(model.selectedProject?.name ?? "project")"
        case 1: return names[0]
        default: return "\(names.count) conversations"
        }
    }

    @ViewBuilder private var content: some View {
        if model.askMessages.isEmpty {
            emptyState
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(model.askMessages) { AskBubble(message: $0).id($0.id) }
                        if let error = model.askError {
                            Text(error).font(.callout).foregroundStyle(.red)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding()
                }
                .onChange(of: model.askMessages.last?.text) { _, _ in
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Ask your conversations anything. Answers cite the recordings they come from.")
                .font(.callout).foregroundStyle(.secondary)
            ForEach(Self.suggestions, id: \.self) { suggestion in
                Button { input = suggestion } label: {
                    Text(suggestion).frame(maxWidth: .infinity, alignment: .leading).padding()
                }
                .glassEffect(.regular, in: .rect(cornerRadius: 16))
                .foregroundStyle(.primary)
            }
            Spacer()
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var inputBar: some View {
        HStack(spacing: 10) {
            TextField("Ask…", text: $input, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
            Button {
                let text = input
                input = ""
                Task { await model.sendAsk(text) }
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.title)
            }
            .tint(BrandColor.royalBlue)
            .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty || model.askStreaming)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
    }

    private static let suggestions = [
        "What did I talk about this week?",
        "Summarize my last conversation.",
        "What decisions did we make?",
    ]
}

/// One chat bubble — user (trailing, tinted) or assistant (leading, with sources).
private struct AskBubble: View {
    let message: AskMessage

    var body: some View {
        if message.role == .user {
            HStack {
                Spacer(minLength: 40)
                Text(message.text)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(BrandColor.royalBlue, in: .rect(cornerRadius: 18))
                    .foregroundStyle(.white)
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if message.text.isEmpty {
                    ProgressView()
                } else {
                    Text(message.text).textSelection(.enabled).foregroundStyle(.primary)
                }
                if !message.references.isEmpty { sources }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var sources: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Sources").font(.caption2).foregroundStyle(.secondary)
            ForEach(uniqueTitles, id: \.self) { title in
                Label(title, systemImage: "waveform")
                    .font(.caption).foregroundStyle(BrandColor.royalBlue).lineLimit(1)
            }
        }
        .padding(.top, 4)
    }

    private var uniqueTitles: [String] {
        var seen = Set<String>()
        return message.references.compactMap { ref in
            let title = ref.conversationTitle ?? ref.conversation
            return seen.insert(title).inserted ? title : nil
        }
    }
}

/// Multi-select the conversations the chat should focus on.
private struct AskContextPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(filtered) { conv in
                        Button { model.toggleAskConversation(conv.id) } label: {
                            HStack {
                                Text(conv.displayTitle).foregroundStyle(.primary).lineLimit(1)
                                Spacer()
                                if model.askConversationIds.contains(conv.id) {
                                    Image(systemName: "checkmark").foregroundStyle(BrandColor.royalBlue)
                                }
                            }
                        }
                    }
                } header: {
                    Text("Choose conversations to focus on. Leave empty to ask across the whole project.")
                }
            }
            .searchable(text: $search, prompt: "Search conversations")
            .navigationTitle("Context")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    private var filtered: [Conversation] {
        guard !search.isEmpty else { return model.conversations }
        return model.conversations.filter {
            $0.displayTitle.localizedCaseInsensitiveContains(search)
        }
    }
}

/// Past chats for the project; tap to resume.
private struct AskHistoryView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var chats: [Chat] = []
    @State private var loading = true

    var body: some View {
        NavigationStack {
            List {
                if loading {
                    HStack { Spacer(); ProgressView(); Spacer() }
                } else if chats.isEmpty {
                    Text("No past chats yet.").foregroundStyle(.secondary)
                } else {
                    ForEach(chats) { chat in
                        Button {
                            Task { await model.openChat(chat); dismiss() }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(chat.name?.isEmpty == false ? chat.name! : "Chat")
                                    .foregroundStyle(.primary).lineLimit(1)
                                if let date = chat.dateCreated {
                                    Text(date.formatted(date: .abbreviated, time: .shortened))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task {
                chats = await model.recentChats()
                loading = false
            }
        }
    }
}

#Preview {
    AskView().environment(AppModel.makeMock())
}
