import SwiftUI
import DembraneCore
#if canImport(UIKit)
import UIKit
#endif

/// Tap a conversation → this sheet (swipe down to dismiss). Mirrors the web
/// detail page: summary first, then the full transcript, each copyable.
struct ConversationDetailView: View {
    let conversation: Conversation
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var full: Conversation?
    @State private var copied: CopyTarget?
    @State private var showEdit = false
    @State private var showMove = false
    @State private var showTags = false
    @State private var confirmDelete = false
    @State private var tags: [ProjectTag] = []
    @State private var chunks: [ConversationChunk] = []
    @State private var loadingTranscript = true
    @State private var working = false

    private var hasSummary: Bool {
        !((current.summary ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    /// Run a conversation action, then refresh the detail.
    private func runAction(_ action: @escaping () async throws -> Void) {
        Task {
            working = true
            defer { working = false }
            try? await action()
            full = try? await model.conversationDetail(id: conversation.id)
        }
    }

    private enum CopyTarget { case summary, transcript }
    private var current: Conversation { full ?? conversation }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    metaLine
                    tagsChips
                    summarySection
                    transcriptSection
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .navigationTitle(current.displayTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                        model.askAbout(conversation)
                    } label: {
                        Label("Ask", systemImage: "sparkles")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { showEdit = true } label: { Label("Edit", systemImage: "pencil") }
                        Button { showTags = true } label: { Label("Tags", systemImage: "tag") }
                        Button { showMove = true } label: { Label("Move to project", systemImage: "folder") }
                        Section {
                            Button { runAction { try await model.summarizeConversation(conversation.id) } } label: {
                                Label(hasSummary ? "Regenerate summary" : "Generate summary", systemImage: "sparkles")
                            }
                            Button { runAction { try await model.generateConversationTitle(conversation.id) } } label: {
                                Label("Generate title", systemImage: "textformat")
                            }
                            .disabled(!hasSummary)
                            Button { runAction { try await model.retranscribeConversation(conversation.id) } } label: {
                                Label("Re-transcribe", systemImage: "arrow.clockwise")
                            }
                        }
                        Button(role: .destructive) { confirmDelete = true } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    } label: {
                        if working { ProgressView() } else { Image(systemName: "ellipsis.circle") }
                    }
                    .disabled(working)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                async let detailTask = model.conversationDetail(id: conversation.id)
                async let chunksTask = model.conversationChunks(id: conversation.id)
                async let tagsTask = model.conversationTags(conversation.id)
                full = try? await detailTask
                chunks = (try? await chunksTask) ?? []
                tags = (try? await tagsTask) ?? []
                loadingTranscript = false
            }
            .sheet(isPresented: $showEdit, onDismiss: {
                Task { full = try? await model.conversationDetail(id: conversation.id) }
            }) {
                ConversationEditView(conversation: current)
            }
            .sheet(isPresented: $showTags, onDismiss: {
                Task { tags = (try? await model.conversationTags(conversation.id)) ?? [] }
            }) {
                ConversationTagsView(conversation: current)
            }
            .sheet(isPresented: $showMove) {
                ProjectPicker { workspaceProject in
                    Task { await model.moveConversation(conversation.id, to: workspaceProject.project.id) }
                    dismiss()
                }
            }
            .confirmationDialog("Delete this conversation?",
                                isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    Task { await model.deleteConversation(conversation) }
                    dismiss()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Audio is kept for a short grace period.")
            }
        }
        .presentationDragIndicator(.visible)
    }

    private var metaLine: some View {
        HStack(spacing: 6) {
            Image(systemName: "waveform").foregroundStyle(BrandColor.royalBlue)
            Text(current.statusLabel)
            if let duration = current.duration, duration > 0 {
                Text("· \(Self.format(duration))")
            }
            if let date = current.createdAt {
                Text("· \(date.formatted(date: .abbreviated, time: .shortened))")
            }
        }
        .font(.caption).foregroundStyle(.secondary)
    }

    @ViewBuilder private var tagsChips: some View {
        if !tags.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(tags) { tag in
                        Text(tag.text)
                            .font(.caption)
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(BrandColor.royalBlue.opacity(0.12), in: .capsule)
                            .foregroundStyle(BrandColor.royalBlue)
                    }
                }
            }
        }
    }

    @ViewBuilder private var summarySection: some View {
        let summary = current.summary?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let summary, !summary.isEmpty {
            section(title: "Summary",
                    accessibilityCopy: "Copy summary",
                    isCopied: copied == .summary,
                    onCopy: { copy(summary, as: .summary) }) {
                Text(Self.markdown(summary))
                    .textSelection(.enabled)
                    .foregroundStyle(.primary)
            }
        }
    }

    /// Transcribed chunks in order (those with text).
    private var orderedChunks: [ConversationChunk] {
        chunks
            .sorted { ($0.timestamp ?? .distantPast) < ($1.timestamp ?? .distantPast) }
            .filter { !($0.transcript?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) }
    }

    /// Full transcript text for copy/share — merged if present, else chunks joined.
    private var transcriptText: String {
        if let merged = current.mergedTranscript?.trimmingCharacters(in: .whitespacesAndNewlines),
           !merged.isEmpty {
            return merged
        }
        return orderedChunks
            .compactMap { $0.transcript?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .joined(separator: " ")
    }

    @ViewBuilder private var transcriptSection: some View {
        let merged = current.mergedTranscript?.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasText = !transcriptText.isEmpty
        section(title: "Transcript",
                accessibilityCopy: "Copy transcript",
                isCopied: copied == .transcript,
                canCopy: hasText,
                shareText: hasText ? transcriptText : nil,
                onCopy: { if hasText { copy(transcriptText, as: .transcript) } }) {
            if let merged, !merged.isEmpty {
                Text(merged).textSelection(.enabled).foregroundStyle(.primary)
            } else if !orderedChunks.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(orderedChunks) { chunk in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(offsetLabel(chunk))
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(.secondary)
                            Text(chunk.transcript ?? "")
                                .textSelection(.enabled)
                                .foregroundStyle(.primary)
                        }
                    }
                }
            } else if loadingTranscript {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Loading…").foregroundStyle(.secondary)
                }
            } else {
                Text(current.isAudioProcessingFinished == true
                     ? "No transcript available."
                     : "Transcribing…")
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Timestamp of a chunk relative to the first chunk (M:SS).
    private func offsetLabel(_ chunk: ConversationChunk) -> String {
        guard let first = orderedChunks.first?.timestamp, let t = chunk.timestamp else { return "" }
        let seconds = Int(max(0, t.timeIntervalSince(first)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    private func section<Content: View>(
        title: String,
        accessibilityCopy: String,
        isCopied: Bool,
        canCopy: Bool = true,
        shareText: String? = nil,
        onCopy: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 16) {
                Text(title).font(.headline).foregroundStyle(.primary)
                Spacer()
                if let shareText {
                    ShareLink(item: shareText) {
                        Image(systemName: "square.and.arrow.up").font(.subheadline)
                    }
                    .tint(BrandColor.royalBlue)
                }
                if canCopy {
                    Button(action: onCopy) {
                        Image(systemName: isCopied ? "checkmark" : "doc.on.doc")
                            .font(.subheadline)
                    }
                    .tint(isCopied ? .green : BrandColor.royalBlue)
                    .accessibilityLabel(isCopied ? "Copied" : accessibilityCopy)
                }
            }
            content()
        }
    }

    private func copy(_ text: String, as target: CopyTarget) {
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #endif
        withAnimation { copied = target }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            if copied == target { withAnimation { copied = nil } }
        }
    }

    /// Inline markdown with line breaks preserved — native Text rendering.
    private static func markdown(_ string: String) -> AttributedString {
        (try? AttributedString(
            markdown: string,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(string)
    }

    private static func format(_ seconds: Double) -> String {
        let total = Int(seconds)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
