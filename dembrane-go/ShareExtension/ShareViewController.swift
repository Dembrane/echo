import UIKit
import SwiftUI
import UniformTypeIdentifiers
import DembraneCore

/// Share Extension: import an audio file shared from Voice Memos / Files into a
/// dembrane go project. Shows a confirmation sheet — editable name + a project
/// picker mirroring the app (project list passed via the App Group) — then
/// uploads via the public participant flow (no auth). Source `GO_SHARE`.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        Task {
            let loaded = await loadAudio()
            await present(loaded)
        }
    }

    @MainActor private func present(_ loaded: (url: URL, name: String)?) {
        let projects = AppGroup.readProjects()
        let form = ShareSheetView(
            audioURL: loaded?.url,
            defaultName: loaded?.name ?? "Shared recording",
            contentType: loaded.map { Self.contentType(for: $0.url) } ?? "audio/m4a",
            projects: projects,
            initialProjectId: AppGroup.readProjectId() ?? projects.first?.project.id,
            fallbackProjectName: AppGroup.readProjectName(),
            environment: AppGroup.readEnvironment(),
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

    /// Returns the temp copy URL plus the ORIGINAL file's name (no UUID prefix).
    private func loadAudio() async -> (url: URL, name: String)? {
        guard let item = extensionContext?.inputItems.first as? NSExtensionItem,
              let attachment = item.attachments?.first else { return nil }
        return await withCheckedContinuation { continuation in
            attachment.loadFileRepresentation(forTypeIdentifier: UTType.audio.identifier) { url, _ in
                guard let url else { continuation.resume(returning: nil); return }
                let original = url.deletingPathExtension().lastPathComponent
                // The provided URL is reclaimed after this closure — copy it out.
                let dest = FileManager.default.temporaryDirectory
                    .appendingPathComponent(UUID().uuidString + "-" + url.lastPathComponent)
                try? FileManager.default.copyItem(at: url, to: dest)
                let ok = FileManager.default.fileExists(atPath: dest.path)
                continuation.resume(returning: ok ? (dest, original) : nil)
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

/// Confirmation form: editable name + destination project picker, then upload.
private struct ShareSheetView: View {
    let audioURL: URL?
    let defaultName: String
    let contentType: String
    let projects: [WorkspaceProject]
    let fallbackProjectName: String?
    let environment: AppEnvironment
    let onClose: () -> Void

    @State private var name: String
    @State private var projectId: String?
    @State private var phase: Phase = .confirm
    private enum Phase { case confirm, uploading, done, failed }

    init(audioURL: URL?, defaultName: String, contentType: String,
         projects: [WorkspaceProject], initialProjectId: String?,
         fallbackProjectName: String?, environment: AppEnvironment,
         onClose: @escaping () -> Void) {
        self.audioURL = audioURL
        self.defaultName = defaultName
        self.contentType = contentType
        self.projects = projects
        self.fallbackProjectName = fallbackProjectName
        self.environment = environment
        self.onClose = onClose
        _name = State(initialValue: defaultName)
        _projectId = State(initialValue: initialProjectId)
    }

    private var selectedProject: WorkspaceProject? { projects.first { $0.project.id == projectId } }
    private var destinationName: String { selectedProject?.project.name ?? fallbackProjectName ?? "Not set" }
    private var canSave: Bool {
        projectId != nil && audioURL != nil
            && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && phase == .confirm
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Recording name") {
                    TextField("Name", text: $name).disabled(phase != .confirm)
                }
                Section("Destination") {
                    if projects.isEmpty {
                        if let fallbackProjectName {
                            LabeledContent("Project", value: fallbackProjectName)
                        } else {
                            Text("Open dembrane Go and choose a project first, then share again.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    } else {
                        NavigationLink {
                            ProjectPickerList(projects: projects, selectedId: $projectId)
                        } label: {
                            LabeledContent("Project", value: destinationName)
                        }
                        .disabled(phase != .confirm)
                    }
                }
                if audioURL == nil {
                    Text("Couldn't read that audio file.").font(.footnote).foregroundStyle(.red)
                }
                switch phase {
                case .uploading: Label("Saving…", systemImage: "arrow.up.circle").foregroundStyle(.secondary)
                case .done: Label("Saved to dembrane Go", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                case .failed: Label("Upload failed. Try again.", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                case .confirm: EmptyView()
                }
            }
            .navigationTitle("Save to dembrane Go")
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

/// Workspace-grouped project chooser — the extension's equivalent of the app's
/// ProjectPicker (which lives in the app target, so it's reimplemented here).
private struct ProjectPickerList: View {
    let projects: [WorkspaceProject]
    @Binding var selectedId: String?
    @Environment(\.dismiss) private var dismiss

    private var groups: [(workspace: String, items: [WorkspaceProject])] {
        Dictionary(grouping: projects, by: { $0.workspace.name })
            .map { (workspace: $0.key, items: $0.value.sorted { $0.project.name < $1.project.name }) }
            .sorted { $0.workspace < $1.workspace }
    }

    var body: some View {
        List {
            ForEach(groups, id: \.workspace) { group in
                Section(group.workspace) {
                    ForEach(group.items, id: \.project.id) { wp in
                        Button {
                            selectedId = wp.project.id
                            dismiss()
                        } label: {
                            HStack {
                                Text(wp.project.name).foregroundStyle(.primary)
                                Spacer()
                                if wp.project.id == selectedId {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Choose project")
        .navigationBarTitleDisplayMode(.inline)
    }
}
