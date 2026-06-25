import SwiftUI
import DembraneCore

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var showSettings = false
    @State private var selected: Conversation?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Text("Recent").font(.title3.weight(.semibold))
                        Spacer()
                        if !model.recentConversations.isEmpty {
                            Button("See all") { model.selectedTab = .conversations }
                                .font(.subheadline)
                                .tint(BrandColor.royalBlue)
                        }
                    }
                    .padding(.horizontal)

                    if !model.didLoadConversationsOnce {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    } else if model.recentConversations.isEmpty {
                        emptyState
                    } else {
                        recentList
                    }
                }
                .padding(.vertical)
            }
            .navigationTitle(greeting)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: {
                        Image(systemName: "person.crop.circle")
                            .font(.title2)
                            .foregroundStyle(BrandColor.royalBlue)
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .refreshable { await model.loadConversations() }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .sheet(item: $selected) { ConversationDetailView(conversation: $0) }
        }
    }

    private var recentList: some View {
        VStack(spacing: 0) {
            ForEach(model.recentConversations) { conversation in
                Button { selected = conversation } label: {
                    ConversationRow(conversation: conversation)
                        .padding(.horizontal)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
                if conversation.id != model.recentConversations.last?.id {
                    Divider().padding(.leading)
                }
            }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No recordings yet", systemImage: "mic")
        } description: {
            Text("Tap Record below to capture your first conversation.")
        }
        .padding(.top, 40)
    }

    private var greeting: String {
        let first = model.me?.displayName
            .split(separator: " ").first.map(String.init) ?? ""
        return first.isEmpty ? "Welcome" : "Welcome, \(first)"
    }
}

#Preview {
    HomeView().environment(AppModel.makeMock())
}
