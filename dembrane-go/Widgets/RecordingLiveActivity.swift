import ActivityKit
import DembraneCore
import SwiftUI
import WidgetKit

/// The recording Live Activity: a Voice-Memos-style red mic + live timer on the
/// Lock Screen and across the Dynamic Island presentations.
struct RecordingLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RecordingActivityAttributes.self) { context in
            // Lock Screen / banner
            HStack(spacing: 12) {
                Image(systemName: "mic.fill").foregroundStyle(.red)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Recording")
                    Text("saving to \(context.state.projectName)")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                timer(from: context.state.startedAt).font(.title3)
            }
            .padding()
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label("Recording", systemImage: "mic.fill").foregroundStyle(.red)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    timer(from: context.state.startedAt).frame(width: 60)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text("saving to \(context.state.projectName)")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } compactLeading: {
                Image(systemName: "mic.fill").foregroundStyle(.red)
            } compactTrailing: {
                timer(from: context.state.startedAt).frame(width: 44)
            } minimal: {
                Image(systemName: "mic.fill").foregroundStyle(.red)
            }
        }
    }

    private func timer(from start: Date) -> some View {
        Text(timerInterval: start...Date.distantFuture, countsDown: false)
            .monospacedDigit()
    }
}
