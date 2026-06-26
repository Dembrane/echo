import SwiftUI
import DembraneCore

/// One pending (not-yet-uploaded) recording: push to dembrane, export the audio,
/// or delete. Shared by the Home card and the Conversations section.
struct PendingRecordingRow: View {
    @Environment(AppModel.self) private var model
    let recording: LocalRecording
    @Binding var shareFile: ShareableFile?
    @Binding var exportingId: String?

    private var busy: Bool {
        model.uploadingRecordingIds.contains(recording.id) || exportingId == recording.id
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "icloud.slash").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(recording.displayName).font(.subheadline).lineLimit(1)
                Text("Not uploaded · \(Self.relative(recording.createdAt))")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if busy {
                ProgressView()
            } else {
                Menu {
                    Button { Task { await model.uploadPending(recording) } } label: {
                        Label("Push to dembrane", systemImage: "icloud.and.arrow.up")
                    }
                    Button {
                        Task {
                            exportingId = recording.id
                            let url = await model.exportPending(recording)
                            exportingId = nil
                            if let url { shareFile = ShareableFile(url: url) }
                        }
                    } label: { Label("Export audio", systemImage: "square.and.arrow.up") }
                    Button(role: .destructive) {
                        Task { await model.deletePending(recording) }
                    } label: { Label("Delete", systemImage: "trash") }
                } label: {
                    Image(systemName: "ellipsis.circle").font(.title3).foregroundStyle(BrandColor.royalBlue)
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    private static func relative(_ date: Date) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f.localizedString(for: date, relativeTo: Date())
    }
}

/// Home card listing pending uploads (hidden when there are none).
struct PendingRecordingsCard: View {
    @Environment(AppModel.self) private var model
    @State private var shareFile: ShareableFile?
    @State private var exportingId: String?

    var body: some View {
        if !model.pendingRecordings.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Label("Pending uploads", systemImage: "icloud.and.arrow.up")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    .padding(.horizontal)
                VStack(spacing: 0) {
                    ForEach(model.pendingRecordings) { rec in
                        PendingRecordingRow(recording: rec, shareFile: $shareFile, exportingId: $exportingId)
                        if rec.id != model.pendingRecordings.last?.id { Divider().padding(.leading, 16) }
                    }
                }
                .background(Color(.secondarySystemGroupedBackground),
                            in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .padding(.horizontal)
            }
            .sheet(item: $shareFile) { ActivityView(url: $0.url) }
        }
    }
}
