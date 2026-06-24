import SwiftUI
import DembraneCore

struct ConversationRow: View {
    let conversation: Conversation

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: conversation.locked == true ? "lock.fill" : "waveform")
                .foregroundStyle(BrandColor.royalBlue)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(conversation.title ?? "Untitled conversation")
                    .foregroundStyle(BrandColor.graphite)
                HStack(spacing: 8) {
                    Text(conversation.statusLabel)
                    if let duration = conversation.duration {
                        Text("·")
                        Text(Self.format(duration))
                    }
                }
                .font(.caption)
                .foregroundStyle(BrandColor.graphite.opacity(0.6))
            }
            Spacer()
        }
        .padding(.vertical, 4)
    }

    private static func format(_ seconds: Double) -> String {
        let total = Int(seconds)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

#Preview {
    List(Conversation.previews) { ConversationRow(conversation: $0) }
}
