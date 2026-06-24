import SwiftUI
import DembraneCore

/// Tap a conversation → this sheet (swipe down to dismiss). Shows the
/// auto-generated title, summary, and transcript; "Ask" scopes a chat to it.
struct ConversationDetailView: View {
    let conversation: Conversation
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var full: Conversation?

    private var current: Conversation { full ?? conversation }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(spacing: 6) {
                        Image(systemName: "waveform").foregroundStyle(BrandColor.royalBlue)
                        Text(current.statusLabel)
                        if let duration = current.duration {
                            Text("· \(Self.format(duration))")
                        }
                    }
                    .font(.caption).foregroundStyle(.secondary)

                    if let summary = current.summary, !summary.isEmpty {
                        section("Summary", summary)
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Transcript").font(.headline).foregroundStyle(BrandColor.graphite)
                        if let transcript = current.mergedTranscript, !transcript.isEmpty {
                            Text(transcript).foregroundStyle(BrandColor.graphite)
                        } else {
                            Text("Processing audio…").foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .background(BrandColor.parchment)
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

    private func section(_ title: String, _ body: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline).foregroundStyle(BrandColor.graphite)
            Text(body).foregroundStyle(BrandColor.graphite)
        }
    }

    private static func format(_ seconds: Double) -> String {
        let total = Int(seconds)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
