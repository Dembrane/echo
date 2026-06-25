import SwiftUI
import DembraneCore

struct ConversationRow: View {
    let conversation: Conversation

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if conversation.locked == true {
                        Image(systemName: "lock.fill").font(.caption2).foregroundStyle(.secondary)
                    }
                    Text(conversation.displayTitle)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                }
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 3) {
                if let when = relativeTime {
                    Text(when).font(.caption).foregroundStyle(.secondary)
                }
                if let duration = conversation.duration, duration > 0 {
                    Text(Self.duration(duration)).font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 4)
    }

    /// Lead with the summary; fall back to a clean status. Use `isFinished` (the
    /// reliable flag) — `isAudioProcessingFinished` stays false even when done.
    private var subtitle: String {
        if let summary = conversation.summary?.trimmingCharacters(in: .whitespacesAndNewlines),
           !summary.isEmpty {
            return summary
        }
        if conversation.locked == true { return "Locked" }
        if conversation.isFinished != true { return "Recording…" }
        return "No summary yet"
    }

    private var relativeTime: String? {
        guard let date = conversation.createdAt else { return nil }
        return Self.relative.localizedString(for: date, relativeTo: Date())
    }

    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    private static func duration(_ seconds: Double) -> String {
        let total = Int(seconds)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

#Preview {
    List(Conversation.previews) { ConversationRow(conversation: $0) }
}
