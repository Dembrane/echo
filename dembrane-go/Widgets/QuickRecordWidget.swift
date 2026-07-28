import WidgetKit
import SwiftUI
import AppIntents
import DembraneCore

/// One record target on the widget: the default "Go Recordings" hero plus the
/// user's favorite projects (in their chosen order). Tapping a tile starts
/// recording straight into that project.
struct RecordTile: Identifiable {
    let id: String
    let name: String
    let subtitle: String
    let isDefault: Bool
    let entity: ProjectEntity?   // nil → record into the current/default project
}

struct QuickRecordEntry: TimelineEntry {
    let date: Date
    let tiles: [RecordTile]
}

/// Reads the favorites + projects the app mirrors into the App Group. No network,
/// no auth — the app reloads timelines whenever favorites or projects change.
struct QuickRecordProvider: TimelineProvider {
    func placeholder(in context: Context) -> QuickRecordEntry {
        QuickRecordEntry(date: .now, tiles: [
            RecordTile(id: "default", name: "Go Recordings", subtitle: "", isDefault: true, entity: nil),
        ])
    }

    func getSnapshot(in context: Context, completion: @escaping (QuickRecordEntry) -> Void) {
        completion(QuickRecordEntry(date: .now, tiles: Self.tiles()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<QuickRecordEntry>) -> Void) {
        completion(Timeline(entries: [QuickRecordEntry(date: .now, tiles: Self.tiles())], policy: .never))
    }

    static func tiles() -> [RecordTile] {
        let projects = AppGroup.readProjects()
        let byId = Dictionary(projects.map { ($0.project.id, $0) }, uniquingKeysWith: { a, _ in a })
        let defaultId = AppGroup.readDefaultProjectId()

        var result: [RecordTile] = []
        let defaultName = defaultId.flatMap { byId[$0]?.project.name } ?? "Go Recordings"
        let defaultEntity = defaultId.flatMap { id -> ProjectEntity? in
            guard let wp = byId[id] else { return nil }
            return ProjectEntity(id: id, name: wp.project.name, subtitle: wp.subtitle)
        }
        result.append(RecordTile(id: "default", name: defaultName, subtitle: "",
                                  isDefault: true, entity: defaultEntity))

        for fid in AppGroup.readFavorites() where fid != defaultId {
            guard let wp = byId[fid] else { continue }
            result.append(RecordTile(id: fid, name: wp.project.name, subtitle: wp.subtitle,
                                      isDefault: false,
                                      entity: ProjectEntity(id: fid, name: wp.project.name, subtitle: wp.subtitle)))
        }
        return result
    }
}

struct QuickRecordWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: QuickRecordEntry

    private var maxTiles: Int {
        switch family {
        case .systemSmall: return 1
        case .systemLarge: return 8
        default: return 4
        }
    }

    var body: some View {
        let tiles = Array(entry.tiles.prefix(maxTiles))
        Group {
            if family == .systemSmall {
                // One tile filling the small widget.
                tileView(tiles.first ?? RecordTile(id: "default", name: "Go Recordings",
                                                   subtitle: "", isDefault: true, entity: nil))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                // Square-style cards in a 2-column grid. minHeight (not a fixed
                // height) keeps them from clipping while staying card-shaped.
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                    ForEach(tiles) { tileView($0) }
                }
            }
        }
        .containerBackground(for: .widget) { Color(.systemBackground) }
    }

    /// Mirrors the Home favorite card: record symbol top-left, name bottom-left.
    private func tileView(_ tile: RecordTile) -> some View {
        Button(intent: RecordIntoProjectIntent(project: tile.entity)) {
            VStack(alignment: .leading, spacing: 4) {
                Image(systemName: "record.circle.fill")
                    .font(.title3).foregroundStyle(.red)
                Spacer(minLength: 0)
                Text(tile.name)
                    .font(.caption.weight(.semibold)).foregroundStyle(.primary)
                    .lineLimit(2).multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(10)
            .frame(maxWidth: .infinity, minHeight: 62, alignment: .topLeading)
            .background(tile.isDefault ? BrandColor.royalBlue.opacity(0.12) : Color(.secondarySystemBackground),
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

struct QuickRecordWidget: Widget {
    let kind = "com.dembrane.go.QuickRecord"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: QuickRecordProvider()) { entry in
            QuickRecordWidgetView(entry: entry)
        }
        .configurationDisplayName("Quick record")
        .description("Start a recording into Go Recordings or a favorite project.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
