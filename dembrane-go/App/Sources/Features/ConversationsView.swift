import SwiftUI
import DembraneCore

struct ConversationsView: View {
    @Environment(AppModel.self) private var model
    @State private var showProjectPicker = false
    @State private var selected: Conversation?

    var body: some View {
        NavigationStack {
            List {
                ForEach(model.conversations) { conversation in
                    Button {
                        selected = conversation
                    } label: {
                        ConversationRow(conversation: conversation)
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button {
                            model.askAbout(conversation)
                        } label: {
                            Label("Ask", systemImage: "sparkles")
                        }
                        .tint(BrandColor.royalBlue)
                    }
                }
            }
            .listStyle(.plain)
            .background(BrandColor.parchment)
            .overlay {
                if model.conversations.isEmpty {
                    ContentUnavailableView {
                        Label("No conversations yet", systemImage: "waveform")
                    } description: {
                        Text("Start your first one.")
                    }
                }
            }
            .refreshable { await model.loadConversations() }
            .navigationTitle("Conversations")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showProjectPicker = true
                    } label: {
                        HStack(spacing: 4) {
                            Text(model.selectedProject?.name ?? "Project")
                            Image(systemName: "chevron.down").font(.caption2)
                        }
                        .foregroundStyle(BrandColor.royalBlue)
                    }
                }
            }
            .sheet(isPresented: $showProjectPicker) {
                ProjectPicker { model.selectProject($0) }
            }
            .sheet(item: $selected) { conversation in
                ConversationDetailView(conversation: conversation)
            }
        }
    }
}

#Preview {
    ConversationsView().environment(AppModel.makeMock())
}
