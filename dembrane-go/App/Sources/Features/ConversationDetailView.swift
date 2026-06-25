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
                        Button(role: .destructive) { confirmDelete = true } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                full = try? await model.conversationDetail(id: conversation.id)
                tags = (try? await model.conversationTags(conversation.id)) ?? []
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

    @ViewBuilder private var transcriptSection: some View {
        let transcript = current.mergedTranscript?.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasTranscript = !(transcript ?? "").isEmpty
        section(title: "Transcript",
                accessibilityCopy: "Copy transcript",
                isCopied: copied == .transcript,
                canCopy: hasTranscript,
                shareText: hasTranscript ? transcript : nil,
                onCopy: { if let transcript { copy(transcript, as: .transcript) } }) {
            if let transcript, hasTranscript {
                Text(transcript)
                    .textSelection(.enabled)
                    .foregroundStyle(.primary)
            } else {
                Text(current.isAudioProcessingFinished == true
                     ? "No transcript available yet."
                     : "Transcribing…")
                    .foregroundStyle(.secondary)
            }
        }
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
