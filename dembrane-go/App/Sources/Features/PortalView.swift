import SwiftUI
import CoreImage.CIFilterBuiltins
import DembraneCore

/// Generates a QR image for a string (CoreImage, cached context).
enum QRGenerator {
    private static let context = CIContext()
    static func image(from string: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        // "H" (30% error correction) so it still scans with the logo over the center.
        filter.correctionLevel = "H"
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
        ZStack {
            if let ui = QRGenerator.image(from: string) {
                Image(uiImage: ui).resizable().interpolation(.none).scaledToFit()
            } else {
                Image(systemName: "qrcode").resizable().scaledToFit().foregroundStyle(.secondary)
            }
            // dembrane logomark (tightly cropped) in the center, like the web portal QR.
            Image("LogomarkTight")
                .resizable().scaledToFit()
                .frame(width: size * 0.2, height: size * 0.2)
                .padding(size * 0.03)
                .background(.white, in: RoundedRectangle(cornerRadius: size * 0.045, style: .continuous))
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
                    Text("Share this project's link. People record on their own phone and it lands here for you to review and ask.")
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
    @State private var keyTerms: [String] = []
    @State private var newTerm = ""
    @State private var loaded = false
    @State private var saving = false
    @AppStorage("dembrane.go.portalInfoDismissed") private var infoDismissed = false
    @State private var activity: ShareableItems?

    private var portalURL: URL { model.portalURL(for: project) }
    private var inviter: String {
        model.me?.displayName.split(separator: " ").first.map(String.init) ?? "I"
    }
    private var inviteMessage: String {
        let t = title.trimmingCharacters(in: .whitespaces)
        return t.isEmpty ? "\(inviter) invited you to record on dembrane."
                         : "\(inviter) invited you to record: \(t)"
    }

    var body: some View {
        NavigationStack {
            Form {
                if !infoDismissed {
                    Section {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "info.circle.fill").foregroundStyle(BrandColor.royalBlue)
                            Text("People who scan this record on their own phone, no account needed. Their recordings appear in “\(project.name)” for you to review and ask about.")
                                .font(.footnote).foregroundStyle(.secondary)
                            Spacer(minLength: 0)
                            Button { withAnimation { infoDismissed = true } } label: {
                                Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                            }
                            .buttonStyle(.plain).accessibilityLabel("Dismiss")
                        }
                    }
                }

                Section {
                    VStack(spacing: 16) {
                        QRCodeImage(string: portalURL.absoluteString, size: 210)
                            .contextMenu {
                                Button { shareInvite(imageOnly: true) } label: {
                                    Label("Share image", systemImage: "photo")
                                }
                            }
                        Button { shareInvite(imageOnly: false) } label: {
                            Label("Share invite", systemImage: "square.and.arrow.up")
                                .labelStyle(.titleAndIcon)
                                .font(.headline)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 4)
                        }
                        .buttonStyle(.glassProminent).tint(BrandColor.royalBlue)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 8)
                    .listRowBackground(Color.clear)
                }

                Section("Default title") {
                    TextField("e.g. Share your experience", text: $title).disabled(!loaded)
                }
                Section("Description") {
                    TextField("What you'd like people to talk about", text: $description, axis: .vertical)
                        .lineLimit(2...5).disabled(!loaded)
                }
                Section {
                    keyTermsEditor
                } header: {
                    Text("Key terms")
                } footer: {
                    Text("Names, jargon, or places. Add them one at a time to improve transcription.")
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
            .task { await load() }
            .sheet(item: $activity) { ActivityView(items: $0.items) }
        }
    }

    /// Share the invite: the QR image (so it works in WhatsApp/iMessage) plus the
    /// invite text + link. `imageOnly` shares just the QR (from the long-press menu).
    @MainActor private func shareInvite(imageOnly: Bool) {
        let renderer = ImageRenderer(content: QRCodeImage(string: portalURL.absoluteString, size: 320))
        renderer.scale = 3
        var items: [Any] = []
        if let image = renderer.uiImage { items.append(image) }
        if !imageOnly { items.append("\(inviteMessage)\n\(portalURL.absoluteString)") }
        if items.isEmpty { items = [portalURL] }
        activity = ShareableItems(items: items)
    }

    private var keyTermsEditor: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !keyTerms.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(keyTerms, id: \.self) { term in
                            HStack(spacing: 4) {
                                Text(term).font(.caption)
                                Button { keyTerms.removeAll { $0 == term } } label: {
                                    Image(systemName: "xmark.circle.fill").font(.caption2)
                                }
                                .buttonStyle(.plain)
                            }
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(BrandColor.royalBlue.opacity(0.12), in: .capsule)
                            .foregroundStyle(BrandColor.royalBlue)
                        }
                    }
                }
            }
            HStack {
                TextField("Add a term", text: $newTerm).disabled(!loaded).onSubmit(addTerm)
                Button(action: addTerm) { Image(systemName: "plus.circle.fill") }
                    .disabled(newTerm.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private func addTerm() {
        let t = newTerm.trimmingCharacters(in: .whitespaces)
        newTerm = ""
        guard !t.isEmpty, !keyTerms.contains(t) else { return }
        keyTerms.append(t)
    }

    private func load() async {
        if let s = await model.portalSettings(projectId: project.id) {
            title = s.defaultConversationTitle ?? ""
            description = s.defaultConversationDescription ?? ""
            keyTerms = (s.context ?? "")
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
        }
        loaded = true
    }

    private func save() async {
        saving = true
        let ok = await model.updatePortalSettings(
            projectId: project.id, title: title, description: description,
            context: keyTerms.joined(separator: ", "))
        saving = false
        if ok { dismiss() }
    }
}
