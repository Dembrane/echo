import UIKit
import SwiftUI
import UniformTypeIdentifiers
import DembraneCore

/// Share Extension: import an audio file shared from Voice Memos / Files into the
/// active dembrane go project. Now shows a confirmation sheet — the destination
/// project (passed via the App Group) and an editable name — before uploading via
/// the public participant flow (no auth). Source `GO_SHARE`.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        Task {
            let url = await loadAudioURL()
            await present(url: url)
        }
    }

    @MainActor private func present(url: URL?) {
        let form = ShareSheetView(
            audioURL: url,
            projectId: AppGroup.readProjectId(),
            projectName: AppGroup.readProjectName(),
            environment: AppGroup.readEnvironment(),
            defaultName: url?.deletingPathExtension().lastPathComponent ?? "Shared recording",
            contentType: url.map(Self.contentType(for:)) ?? "audio/m4a",
            onClose: { [weak self] in
                self?.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
            }
        )
        let host = UIHostingController(rootView: form)
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    private func loadAudioURL() async -> URL? {
        guard let item = extensionContext?.inputItems.first as? NSExtensionItem,
              let attachment = item.attachments?.first else { return nil }
        return await withCheckedContinuation { continuation in
            attachment.loadFileRepresentation(forTypeIdentifier: UTType.audio.identifier) { url, _ in
                guard let url else { continuation.resume(returning: nil); return }
                // The provided URL is reclaimed after this closure — copy it out.
                let dest = FileManager.default.temporaryDirectory
                    .appendingPathComponent(UUID().uuidString + "-" + url.lastPathComponent)
                try? FileManager.default.copyItem(at: url, to: dest)
                continuation.resume(returning: FileManager.default.fileExists(atPath: dest.path) ? dest : nil)
            }
        }
    }

    static func contentType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        case "caf": return "audio/x-caf"
        default: return "audio/m4a"
        }
    }
}

/// Confirmation form: shows the destination project, lets the user rename, then
/// uploads on Save (or dismisses on Cancel).
private struct ShareSheetView: View {
    let audioURL: URL?
    let projectId: String?
    let projectName: String?
    let environment: AppEnvironment
    let contentType: String
    let onClose: () -> Void

    @State private var name: String
    @State private var phase: Phase = .confirm
    private enum Phase { case confirm, uploading, done, failed }

    init(audioURL: URL?, projectId: String?, projectName: String?,
         environment: AppEnvironment, defaultName: String, contentType: String,
         onClose: @escaping () -> Void) {
        self.audioURL = audioURL
        self.projectId = projectId
        self.projectName = projectName
        self.environment = environment
        self.contentType = contentType
        self.onClose = onClose
        _name = State(initialValue: defaultName)
    }

    private var canSave: Bool {
        projectId != nil && audioURL != nil
            && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && phase == .confirm
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Recording name") {
                    TextField("Name", text: $name)
                        .disabled(phase != .confirm)
                }
                Section("Destination") {
                    if let projectName {
                        LabeledContent("Project", value: projectName)
                    } else {
                        Text("Open dembrane go and choose a project first, then share again.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if audioURL == nil {
                    Text("Couldn't read that audio file.")
                        .font(.footnote).foregroundStyle(.red)
                }
                switch phase {
                case .uploading:
                    Label("Saving…", systemImage: "arrow.up.circle")
                        .foregroundStyle(.secondary)
                case .done:
                    Label("Saved to dembrane go", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                case .failed:
                    Label("Upload failed — try again.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                case .confirm:
                    EmptyView()
                }
            }
            .navigationTitle("Save to dembrane go")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onClose).disabled(phase == .uploading)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await upload() } }.disabled(!canSave)
                }
            }
        }
    }

    private func upload() async {
        guard let projectId, let audioURL else { return }
        phase = .uploading
        do {
            let uploader = ParticipantUploadClient(env: environment)
            _ = try await uploader.upload(
                projectId: projectId,
                fileURL: audioURL,
                displayName: name.trimmingCharacters(in: .whitespacesAndNewlines),
                contentType: contentType,
                source: "GO_SHARE",
                recordedAt: Date())
            phase = .done
            try? await Task.sleep(for: .seconds(0.7))
            onClose()
        } catch {
            phase = .failed
        }
    }
}
