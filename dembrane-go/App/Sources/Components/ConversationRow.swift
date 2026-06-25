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
                Text(conversation.displayTitle)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }

    /// Lead with the summary; fall back to a clean status + duration.
    private var subtitle: String {
        if let summary = conversation.summary?.trimmingCharacters(in: .whitespacesAndNewlines),
           !summary.isEmpty {
            return summary
        }
        var parts: [String] = []
        if conversation.locked == true {
            parts.append("Locked")
        } else if conversation.isAudioProcessingFinished != true {
            parts.append("Transcribing…")
        } else {
            parts.append("No summary yet")
        }
        if let duration = conversation.duration, duration > 0 {
            parts.append(Self.format(duration))
        }
        return parts.joined(separator: " · ")
    }

    private static func format(_ seconds: Double) -> String {
        let total = Int(seconds)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

#Preview {
    List(Conversation.previews) { ConversationRow(conversation: $0) }
}
