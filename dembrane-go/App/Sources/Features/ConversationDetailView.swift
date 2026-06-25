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

    private enum CopyTarget { case summary, transcript }
    private var current: Conversation { full ?? conversation }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    metaLine
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
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { full = try? await model.conversationDetail(id: conversation.id) }
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
        onCopy: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).font(.headline).foregroundStyle(.primary)
                Spacer()
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
