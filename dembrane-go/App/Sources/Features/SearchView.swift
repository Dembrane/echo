import SwiftUI
import DembraneCore

/// The dedicated search tab (Tab(role: .search)) — expands into a Liquid Glass
/// search field. Searches the project's conversations and offers to Ask
/// dembrane the query directly.
struct SearchView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var selected: Conversation?

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var results: [Conversation] {
        guard !trimmed.isEmpty else { return [] }
        // Search across what we've loaded: cross-project recents + the current
        // project's conversations, deduped.
        var seen = Set<String>()
        let pool = (model.crossProjectRecents + model.conversations).filter { seen.insert($0.id).inserted }
        return pool.filter {
            $0.displayTitle.localizedCaseInsensitiveContains(trimmed)
                || ($0.summary?.localizedCaseInsensitiveContains(trimmed) ?? false)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if !trimmed.isEmpty {
                    Section {
                        Button {
                            model.pendingAskQuery = trimmed
                            model.selectedTab = .ask
                        } label: {
                            Label("Ask dembrane “\(trimmed)”", systemImage: "sparkles")
                                .foregroundStyle(BrandColor.royalBlue)
                        }
                    }
                }
                if !results.isEmpty {
                    Section("Conversations") {
                        ForEach(results) { conversation in
                            Button { selected = conversation } label: {
                                ConversationRow(conversation: conversation,
                                                projectName: model.recentsProjectName(conversation))
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .listStyle(.plain)
            .overlay {
                if trimmed.isEmpty {
                    ContentUnavailableView {
                        Label("Search", systemImage: "magnifyingglass")
                    } description: {
                        Text("Find a conversation, or ask dembrane anything.")
                    }
                } else if results.isEmpty {
                    ContentUnavailableView.search(text: trimmed)
                }
            }
            .navigationTitle("Search")
            .sheet(item: $selected) { ConversationDetailView(conversation: $0) }
        }
        .searchable(text: $query, prompt: "Conversations, transcripts, ask…")
    }
}

#Preview {
    SearchView().environment(AppModel.makeMock())
}
