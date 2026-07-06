import SwiftUI
import UniformTypeIdentifiers
import DembraneCore

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var showSettings = false
    @State private var selected: Conversation?
    @State private var showImporter = false
    @State private var importProject: Project?      // destination for the next file import
    @State private var inviteProject: Project?       // drives the Invite (portal) sheet
    @State private var showPicker = false
    @State private var showReorder = false
    @State private var showAllRecents = false

    /// Everything on Home (record, invite, upload) targets the default capture
    /// project; we fall back to the current selection until projects load.
    private var heroProject: Project? { model.defaultProject ?? model.selectedProject }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    freeTierBanner
                    heroRow
                    PendingRecordingsCard()
                    favoritesSection
                    recentSection
                }
                .padding(.vertical)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(greeting)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { avatarLabel }
                        .buttonStyle(.plain)   // no toolbar chrome around the avatar
                        .accessibilityLabel("Settings")
                }
            }
            .refreshable { await model.loadConversations(); await model.loadRecents() }
            .fileImporter(isPresented: $showImporter, allowedContentTypes: [.audio]) { result in
                if case .success(let url) = result {
                    let dest = importProject?.id
                    Task { await model.importAudioFile(url, into: dest) }
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .sheet(item: $selected) { ConversationDetailView(conversation: $0) }
            .sheet(item: $inviteProject) { PortalSheet(project: $0) }
            .sheet(isPresented: $showPicker) {
                ProjectPicker { model.selectProject($0) }   // favoriting happens via the ♥ on each row
            }
            .sheet(isPresented: $showReorder) { FavoritesReorderSheet() }
            .sheet(isPresented: $showAllRecents) { CrossProjectRecentsView() }
        }
    }

    // The user's avatar when available, else the default person glyph — a clean
    // 32pt circle that fills edge-to-edge (no internal padding), HIG nav-bar style.
    private static let avatarSize: CGFloat = 32
    @ViewBuilder private var avatarLabel: some View {
        if let url = model.avatarURL {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else {
                    placeholderAvatar
                }
            }
            .frame(width: Self.avatarSize, height: Self.avatarSize)
            .clipShape(.circle)
            .overlay(Circle().strokeBorder(.quaternary, lineWidth: 0.5))
        } else {
            placeholderAvatar
        }
    }

    private var placeholderAvatar: some View {
        Image(systemName: "person.crop.circle.fill")
            .resizable().scaledToFit()
            .frame(width: Self.avatarSize, height: Self.avatarSize)
            .foregroundStyle(BrandColor.royalBlue)
    }

    // Informational only — no in-app purchase button/link, and no copy pointing
    // at where to pay (3.1.1 counts "calls to action" toward external purchase
    // as steering, even without a link). Plan changes happen on the web dashboard.
    @ViewBuilder private var freeTierBanner: some View {
        if model.uploadsLocked {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Uploads paused").font(.subheadline.weight(.semibold))
                    Text("You've reached your plan's limit. New recordings stay safely on this device for now.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .padding(.horizontal)
        }
    }

    // MARK: - Hero (Record + destination, paired with Invite + Upload)

    private var heroRow: some View {
        HStack(alignment: .center, spacing: 12) {
            Button {
                if model.isRecording { model.showRecordingScreen = true }
                else if let p = heroProject { Task { await model.startRecording(into: p) } }
                else { Task { await model.startRecording() } }
            } label: {
                Label(model.isRecording ? "View recording" : "Record",
                      systemImage: model.isRecording ? "waveform" : "record.circle.fill")
                    .font(.title3.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.glassProminent)
            .tint(.red)

            // Invite (others record) + Upload (import a file) — the two non-live
            // ways audio lands in the default project, paired beside Record.
            HStack(spacing: 8) {
                Button { inviteProject = heroProject } label: {
                    Image(systemName: "qrcode").font(.title3).frame(width: 30, height: 38)
                }
                .buttonStyle(.glass)
                .disabled(heroProject == nil)
                .accessibilityLabel("Invite others to record")

                Button { importProject = heroProject; showImporter = true } label: {
                    Image(systemName: "icloud.and.arrow.up").font(.title3).frame(width: 30, height: 38)
                }
                .buttonStyle(.glass)
                .accessibilityLabel("Upload an audio file")
            }
        }
        .padding(.horizontal)
    }

    // MARK: - Favorites shelf

    @ViewBuilder private var favoritesSection: some View {
        let favorites = model.favoriteProjects
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Favorites").font(.title3.weight(.semibold))
                Spacer()
                if favorites.count > 1 {
                    Button("Reorder") { showReorder = true }
                        .font(.subheadline).tint(BrandColor.royalBlue)
                }
            }
            .padding(.horizontal)

            // Empty state only when there genuinely are no favorites — not while
            // ids are still resolving against the (cache-seeded) project list.
            if model.favoriteProjectIds.isEmpty {
                Button { showPicker = true } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "heart.text.square")
                            .font(.title2).foregroundStyle(BrandColor.royalBlue)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Favorite a project").font(.subheadline.weight(.semibold))
                                .foregroundStyle(.primary)
                            Text("Tap ♥ in the picker to pin projects here for one-tap recording.")
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
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(favorites) { favoriteCard($0) }
                        addFavoriteCard
                    }
                    .padding(.horizontal)
                }
            }
        }
    }

    private func favoriteCard(_ wp: WorkspaceProject) -> some View {
        Button { Task { await model.startRecording(into: wp.project) } } label: {
            VStack(alignment: .leading, spacing: 4) {
                Image(systemName: "record.circle.fill").font(.title3).foregroundStyle(.red)
                Spacer(minLength: 0)
                Text(wp.project.name)
                    .font(.caption2.weight(.medium)).foregroundStyle(.primary)
                    .lineLimit(2).multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(8)
            .frame(width: 84, height: 84, alignment: .topLeading)
            .background(Color(.secondarySystemGroupedBackground),
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button { model.selectProject(wp); model.selectedTab = .conversations } label: {
                Label("Open", systemImage: "folder")
            }
            Button { model.setDefaultProject(wp) } label: {
                Label("Set as default", systemImage: "star")
            }
            Button { inviteProject = wp.project } label: {
                Label("Invite to record", systemImage: "qrcode")
            }
            Button { importProject = wp.project; showImporter = true } label: {
                Label("Import file", systemImage: "icloud.and.arrow.up")
            }
            Button(role: .destructive) { model.unfavorite(wp.project.id) } label: {
                Label("Unfavorite", systemImage: "heart.slash")
            }
        }
    }

    private var addFavoriteCard: some View {
        Button { showPicker = true } label: {
            VStack(spacing: 6) {
                Image(systemName: "plus").font(.title3)
                Text("Add").font(.caption2)
            }
            .foregroundStyle(BrandColor.royalBlue)
            .frame(width: 84, height: 84)
            .background(BrandColor.royalBlue.opacity(0.08),
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Favorite another project")
    }

    // MARK: - Cross-project recents

    private var recentSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Recent recordings").font(.title3.weight(.semibold))
                Spacer()
                if !model.crossProjectRecents.isEmpty {
                    Button("See all") { showAllRecents = true }
                        .font(.subheadline).tint(BrandColor.royalBlue)
                }
            }
            .padding(.horizontal)

            if !model.didLoadRecentsOnce {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 24)
            } else if model.crossProjectRecents.isEmpty {
                ContentUnavailableView {
                    Label("No recordings yet", systemImage: "mic")
                } description: {
                    Text("Tap Record to capture your first conversation.")
                }
                .padding(.top, 24)
            } else {
                recentRows(Array(model.crossProjectRecents.prefix(6)))
            }
        }
    }

    /// Recents rows, each tagged with its project chip (cross-project list).
    /// Long-press opens that conversation's project in the Conversations tab.
    private func recentRows(_ conversations: [Conversation]) -> some View {
        VStack(spacing: 0) {
            ForEach(conversations) { conversation in
                Button { open(conversation) } label: {
                    ConversationRow(conversation: conversation,
                                    projectName: model.recentsProjectName(conversation))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .contextMenu { openInProjectMenu(conversation) }
                if conversation.id != conversations.last?.id {
                    Divider().padding(.leading, 16)
                }
            }
        }
        .background(Color(.secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding(.horizontal)
    }

    /// Long-press action on a cross-project recent: jump to that project in the
    /// Conversations tab.
    @ViewBuilder
    func openInProjectMenu(_ conversation: Conversation) -> some View {
        if let pid = conversation.projectId,
           let wp = model.allProjects.first(where: { $0.project.id == pid }) {
            Button { model.selectProject(wp); model.selectedTab = .conversations } label: {
                Label("Open in \(wp.project.name)", systemImage: "folder")
            }
        }
    }

    /// Tapping the in-progress recording reopens the Now-Recording screen; any
    /// other row opens its transcript detail.
    private func open(_ conversation: Conversation) {
        if conversation.id == model.activeRecordingConversationId {
            model.showRecordingScreen = true
        } else {
            selected = conversation
        }
    }

    private var greeting: String {
        let first = model.me?.displayName.split(separator: " ").first.map(String.init) ?? ""
        return first.isEmpty ? "Welcome" : "Welcome, \(first)"
    }
}

/// Drag-to-reorder the favorites. The order is the single source of truth the
/// Home shelf and the widget both read, so a move writes straight back to it.
private struct FavoritesReorderSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var ids: [String] = []

    private var rows: [WorkspaceProject] {
        let byId = Dictionary(model.allProjects.map { ($0.project.id, $0) }, uniquingKeysWith: { a, _ in a })
        return ids.compactMap { byId[$0] }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(rows) { wp in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(wp.project.name)
                        if !wp.subtitle.isEmpty {
                            Text(wp.subtitle).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .onMove { offsets, to in
                    ids.move(fromOffsets: offsets, toOffset: to)
                    model.setFavorites(ids)
                }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle("Reorder favorites")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .onAppear { ids = model.favoriteProjects.map(\.project.id) }
        }
    }
}

/// The distinct cross-project recents list behind "See all" (not the
/// project-scoped Conversations tab).
private struct CrossProjectRecentsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var selected: Conversation?

    var body: some View {
        NavigationStack {
            List(model.crossProjectRecents) { conversation in
                Button { open(conversation) } label: {
                    ConversationRow(conversation: conversation,
                                    projectName: model.recentsProjectName(conversation))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .contextMenu {
                    if let pid = conversation.projectId,
                       let wp = model.allProjects.first(where: { $0.project.id == pid }) {
                        Button {
                            model.selectProject(wp)
                            model.selectedTab = .conversations
                            dismiss()
                        } label: {
                            Label("Open in \(wp.project.name)", systemImage: "folder")
                        }
                    }
                }
            }
            .listStyle(.plain)
            .navigationTitle("Recent recordings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .refreshable { await model.loadRecents() }
            .sheet(item: $selected) { ConversationDetailView(conversation: $0) }
        }
    }

    private func open(_ conversation: Conversation) {
        if conversation.id == model.activeRecordingConversationId {
            model.showRecordingScreen = true
            dismiss()
        } else {
            selected = conversation
        }
    }
}

#Preview {
    HomeView().environment(AppModel.makeMock())
}
