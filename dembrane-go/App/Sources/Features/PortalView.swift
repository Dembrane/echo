import SwiftUI
import CoreImage.CIFilterBuiltins
import DembraneCore

/// Generates a QR image for a string (CoreImage, cached context).
enum QRGenerator {
    private static let context = CIContext()
    static func image(from string: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?
                .transformed(by: CGAffineTransform(scaleX: 12, y: 12)),
              let cg = context.createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

struct QRCodeImage: View {
    let string: String
    var size: CGFloat = 200

    var body: some View {
        Group {
            if let ui = QRGenerator.image(from: string) {
                Image(uiImage: ui).resizable().interpolation(.none).scaledToFit()
            } else {
                Image(systemName: "qrcode").resizable().scaledToFit().foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .padding(8)
        .background(.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// Home card: the project's portal QR + a one-line pitch; taps into the editor.
struct PortalQRCard: View {
    @Environment(AppModel.self) private var model
    let project: Project
    @State private var showPortal = false

    var body: some View {
        Button { showPortal = true } label: {
            HStack(spacing: 14) {
                QRCodeImage(string: model.portalURL(for: project).absoluteString, size: 76)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Invite others to record")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                    Text("Share this project's link — people record on their own phone and it lands here for you to review and ask.")
                        .font(.caption).foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
            .padding(12)
            .frame(maxWidth: .infinity)
            .background(Color(.secondarySystemGroupedBackground),
                        in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .padding(.horizontal)
        .sheet(isPresented: $showPortal) { PortalSheet(project: project) }
    }
}

/// Big QR + share link + a miniature portal-settings editor (title / description
/// / key terms) that PATCHes the project.
struct PortalSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let project: Project

    @State private var title = ""
    @State private var description = ""
    @State private var keyTerms = ""
    @State private var loaded = false
    @State private var saving = false

    private var portalURL: URL { model.portalURL(for: project) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 12) {
                        QRCodeImage(string: portalURL.absoluteString, size: 210)
                        Text(portalURL.absoluteString)
                            .font(.caption2).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.middle)
                        ShareLink(item: portalURL) {
                            Label("Share link", systemImage: "square.and.arrow.up")
                        }
                        .buttonStyle(.bordered).tint(BrandColor.royalBlue)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 8)
                    .listRowBackground(Color.clear)
                }

                Section {
                    Text("People who scan this code record on their own phone — no account needed. Their recordings appear in “\(project.name)” for you to review, summarize, and ask about.")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                Section("Default title") {
                    TextField("e.g. Share your experience", text: $title).disabled(!loaded)
                }
                Section("Description") {
                    TextField("What you'd like people to talk about", text: $description, axis: .vertical)
                        .lineLimit(2...5).disabled(!loaded)
                }
                Section {
                    TextField("Names, jargon, or places to help transcription", text: $keyTerms, axis: .vertical)
                        .lineLimit(1...4).disabled(!loaded)
                } header: {
                    Text("Key terms")
                } footer: {
                    Text("Context that improves transcription accuracy for this project.")
                }
            }
            .navigationTitle("Share to record")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView() }
                    else { Button("Save") { Task { await save() } }.disabled(!loaded) }
                }
            }
            .task {
                if let s = await model.portalSettings(projectId: project.id) {
                    title = s.defaultConversationTitle ?? ""
                    description = s.defaultConversationDescription ?? ""
                    keyTerms = s.context ?? ""
                }
                loaded = true
            }
        }
    }

    private func save() async {
        saving = true
        let ok = await model.updatePortalSettings(
            projectId: project.id, title: title, description: description, context: keyTerms)
        saving = false
        if ok { dismiss() }
    }
}
