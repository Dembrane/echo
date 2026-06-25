import SwiftUI
import DembraneCore

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var showSettings = false
    @State private var selected: Conversation?
    @State private var search = ""

    private var trimmed: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var searchResults: [Conversation] {
        guard !trimmed.isEmpty else { return [] }
        return model.conversations.filter {
            $0.displayTitle.localizedCaseInsensitiveContains(trimmed)
                || ($0.summary?.localizedCaseInsensitiveContains(trimmed) ?? false)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                if trimmed.isEmpty {
                    VStack(alignment: .leading, spacing: 24) {
                        recordButton
                        recentSection
                    }
                    .padding(.vertical)
                } else {
                    searchSection
                }
            }
            .navigationTitle(greeting)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: {
                        Image(systemName: "person.crop.circle")
                            .font(.title2).foregroundStyle(BrandColor.royalBlue)
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .searchable(text: $search, prompt: "Search conversations or ask…")
            .refreshable { await model.loadConversations() }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .sheet(item: $selected) { ConversationDetailView(conversation: $0) }
        }
    }

    private var recordButton: some View {
        Button {
            Task { await model.startRecording() }
        } label: {
            Label("Record", systemImage: "record.circle.fill")
                .font(.title3.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
        }
        .buttonStyle(.glassProminent)
        .tint(.red)
        .padding(.horizontal)
    }

    private var recentSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Recent Conversations").font(.title3.weight(.semibold))
                Spacer()
                if !model.recentConversations.isEmpty {
                    Button("See all") { model.selectedTab = .conversations }
                        .font(.subheadline).tint(BrandColor.royalBlue)
                }
            }
            .padding(.horizontal)

            if !model.didLoadConversationsOnce {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 24)
            } else if model.recentConversations.isEmpty {
                ContentUnavailableView {
                    Label("No recordings yet", systemImage: "mic")
                } description: {
                    Text("Tap Record to capture your first conversation.")
                }
                .padding(.top, 24)
            } else {
                rows(model.recentConversations)
            }
        }
    }

    private var searchSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                model.pendingAskQuery = trimmed
                model.selectedTab = .ask
            } label: {
                Label("Ask dembrane “\(trimmed)”", systemImage: "sparkles")
                    .foregroundStyle(BrandColor.royalBlue)
                    .padding(.horizontal)
            }
            if !searchResults.isEmpty {
                rows(searchResults)
            } else {
                Text("No matches for “\(trimmed)”.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 24)
            }
        }
        .padding(.vertical)
    }

    private func rows(_ conversations: [Conversation]) -> some View {
        VStack(spacing: 0) {
            ForEach(conversations) { conversation in
                Button { selected = conversation } label: {
                    ConversationRow(conversation: conversation)
                        .padding(.horizontal)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
                if conversation.id != conversations.last?.id {
                    Divider().padding(.leading)
                }
            }
        }
    }

    private var greeting: String {
        let first = model.me?.displayName.split(separator: " ").first.map(String.init) ?? ""
        return first.isEmpty ? "Welcome" : "Welcome, \(first)"
    }
}

#Preview {
    HomeView().environment(AppModel.makeMock())
}
