import SwiftUI
import DembraneCore

struct ConversationsView: View {
    @Environment(AppModel.self) private var model
    @State private var showProjectPicker = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(model.conversations) { conversation in
                    ConversationRow(conversation: conversation)
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
        }
    }
}

#Preview {
    ConversationsView().environment(AppModel.makeMock())
}
