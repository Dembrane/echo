import SwiftUI
import DembraneCore

struct ConversationsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            Group {
                if model.conversations.isEmpty {
                    ContentUnavailableView {
                        Label("No conversations yet", systemImage: "waveform")
                    } description: {
                        Text("Start your first one.")
                    }
                } else {
                    List(model.conversations) { conversation in
                        ConversationRow(conversation: conversation)
                    }
                    .listStyle(.plain)
                }
            }
            .background(BrandColor.parchment)
            .navigationTitle("Conversations")
        }
    }
}

#Preview {
    ConversationsView().environment(AppModel.makeMock())
}
