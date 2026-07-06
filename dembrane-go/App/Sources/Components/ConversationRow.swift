import SwiftUI
import DembraneCore

struct ConversationRow: View {
    @Environment(AppModel.self) private var model
    let conversation: Conversation
    /// Inline project chip for cross-project lists (Home recents); nil in
    /// project-scoped lists where the project is already implied.
    var projectName: String? = nil

    private var tags: [ProjectTag] { model.conversationTagsCache[conversation.id] ?? [] }
    private var hasDuration: Bool { (conversation.duration ?? 0) > 0 }
    /// Whether there's anything to show on the chip row. When false we skip the
    /// row entirely (no empty gap) and tuck the duration up next to the time.
    private var hasChips: Bool {
        projectName != nil || conversation.isPortalAudio || !tags.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Line 1: title + when (+ duration when there's no chip row to hold it).
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if conversation.locked == true {
                    Image(systemName: "lock.fill").font(.caption2).foregroundStyle(.secondary)
                }
                Text(conversation.displayTitle).foregroundStyle(.primary).lineLimit(1)
                Spacer(minLength: 8)
                if !hasChips, hasDuration, let duration = conversation.duration {
                    Text(Self.duration(duration)).font(.caption2).foregroundStyle(.tertiary).fixedSize()
                }
                if let when = relativeTime {
                    Text(when).font(.caption).foregroundStyle(.secondary).fixedSize()
                }
            }
            // Line 2: chips (project + participant + tags) on the left, duration on
            // the right — only when there's at least one chip.
            if hasChips {
                HStack(spacing: 4) {
                    if let projectName { projectChip(projectName) }
                    if conversation.isPortalAudio { ParticipantBadge() }
                    ForEach(tags.prefix(3)) { tag in tagChip(tag.text) }
                    Spacer(minLength: 4)
                    if hasDuration, let duration = conversation.duration {
                        Text(Self.duration(duration)).font(.caption2).foregroundStyle(.tertiary).fixedSize()
                    }
                }
            }
            // Summary / status — always full width.
            Text(subtitle)
                .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 4)
        .task { await model.loadTagsForRow(conversation.id) }
    }

    private func projectChip(_ name: String) -> some View {
        Label(name, systemImage: "folder")
            .font(.caption2.weight(.medium)).foregroundStyle(.secondary).lineLimit(1)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(.quaternary, in: .capsule)
    }

    private func tagChip(_ text: String) -> some View {
        Text(text).font(.caption2).lineLimit(1)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(BrandColor.royalBlue.opacity(0.12), in: .capsule)
            .foregroundStyle(BrandColor.royalBlue)
    }

    /// Lead with the summary; fall back to a clean status.
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

/// Marks a conversation that a participant recorded via the shared QR portal
/// (source = PORTAL_AUDIO), so hosts can tell it apart from their own recordings.
struct ParticipantBadge: View {
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "person.wave.2.fill")
            Text("Participant")
        }
        .font(.caption2.weight(.medium))
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(.quaternary, in: .capsule)
        .foregroundStyle(.secondary)
        .fixedSize()
        .accessibilityLabel("Recorded by a participant")
    }
}

#Preview {
    List(Conversation.previews) { ConversationRow(conversation: $0) }
        .environment(AppModel.makeMock())
}
