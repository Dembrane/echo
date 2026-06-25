import UIKit
import UniformTypeIdentifiers
import DembraneCore

/// Share Extension: import an audio file shared from Voice Memos / Files into
/// the active dembrane Go project. Uses the public participant upload flow
/// (no auth) with the project + environment passed via the App Group.
final class ShareViewController: UIViewController {
    private let label = UILabel()
    private let spinner = UIActivityIndicatorView(style: .large)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        setupUI()
        Task { await run() }
    }

    private func setupUI() {
        label.text = "Saving to dembrane Go…"
        label.textAlignment = .center
        label.numberOfLines = 0
        label.font = .preferredFont(forTextStyle: .headline)
        label.translatesAutoresizingMaskIntoConstraints = false
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimating()
        view.addSubview(label)
        view.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -24),
            label.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 16),
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
        ])
    }

    private func run() async {
        guard let projectId = AppGroup.readProjectId() else {
            await finish("Open dembrane Go and choose a project first."); return
        }
        let env = AppGroup.readEnvironment()
        guard let url = await loadAudioURL() else {
            await finish("Couldn't read that audio."); return
        }
        do {
            let uploader = ParticipantUploadClient(env: env)
            _ = try await uploader.upload(
                projectId: projectId,
                fileURL: url,
                displayName: url.deletingPathExtension().lastPathComponent,
                contentType: contentType(for: url),
                source: "GO_SHARE",
                recordedAt: Date())
            await finish("Saved to dembrane Go ✓")
        } catch {
            await finish("Upload failed — try again.")
        }
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

    private func contentType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        case "caf": return "audio/x-caf"
        default: return "audio/m4a"
        }
    }

    @MainActor private func finish(_ message: String) async {
        spinner.stopAnimating()
        label.text = message
        try? await Task.sleep(for: .seconds(1.2))
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }
}
