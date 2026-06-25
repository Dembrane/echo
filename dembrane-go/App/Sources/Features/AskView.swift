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
                if !contextConversations.isEmpty { contextChips }
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
        let count = contextConversations.count
        if count == 0 { return "Asking across all of \(model.selectedProject?.name ?? "project")" }
        return "Focused on \(count) conversation\(count == 1 ? "" : "s")"
    }

    private var contextChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(contextConversations) { conv in
                    Text(conv.displayTitle)
                        .font(.caption)
                        .lineLimit(1)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(BrandColor.royalBlue.opacity(0.12), in: .capsule)
                        .foregroundStyle(BrandColor.royalBlue)
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 8)
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

/// Multi-select the conversations the chat should focus on. Selection is local
/// and applied on Done, so toggling several doesn't reset the thread each time.
private struct AskContextPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    @State private var selected: Set<String> = []
    @State private var primed = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(filtered) { conv in
                        Button { toggle(conv.id) } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: selected.contains(conv.id) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(selected.contains(conv.id) ? BrandColor.royalBlue : .secondary)
                                    .font(.title3)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(conv.displayTitle).foregroundStyle(.primary).lineLimit(1)
                                    if let summary = conv.summary?.trimmingCharacters(in: .whitespacesAndNewlines),
                                       !summary.isEmpty {
                                        Text(summary).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                }
                            }
                        }
                    }
                } footer: {
                    Text("Leave empty to ask across the whole project.")
                }
            }
            .overlay {
                if model.conversations.isEmpty {
                    if model.conversationsLoading {
                        ProgressView()
                    } else {
                        ContentUnavailableView("No conversations",
                                               systemImage: "waveform",
                                               description: Text("Record one first."))
                    }
                }
            }
            .searchable(text: $search, prompt: "Search conversations")
            .navigationTitle(selected.isEmpty ? "Choose context" : "\(selected.count) selected")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        model.setAskContext(selected)
                        dismiss()
                    }
                }
            }
            .onAppear {
                if !primed { selected = model.askConversationIds; primed = true }
            }
        }
    }

    private func toggle(_ id: String) {
        if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
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
