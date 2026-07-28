import ActivityKit
import DembraneCore
import SwiftUI
import WidgetKit

/// The recording Live Activity: the dembrane logomark + a live timer, with a
/// recording cue, across the Lock Screen and Dynamic Island presentations.
/// Reflects pause: a frozen time + "Paused" when the recording is paused.
struct RecordingLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RecordingActivityAttributes.self) { context in
            // Lock Screen / banner
            HStack(spacing: 12) {
                logomark.frame(width: 30, height: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.state.isPaused ? "Paused" : "Recording").font(.headline)
                    Text("saving to \(context.state.projectName)")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                dot(context.state)
                timeText(context.state).font(.title3)
            }
            .padding()
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    logomark.frame(width: 26, height: 26)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    HStack(spacing: 5) {
                        dot(context.state)
                        timeText(context.state)
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    Image(systemName: context.state.isPaused ? "pause.fill" : "waveform")
                        .font(.title2)
                        .foregroundStyle(context.state.isPaused ? Color.secondary : .red)
                        .symbolEffect(.variableColor.iterative, isActive: !context.state.isPaused)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text("saving to \(context.state.projectName)")
                        .font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
            } compactLeading: {
                logomark.frame(width: 22, height: 22)
            } compactTrailing: {
                timeText(context.state)
                    .foregroundStyle(context.state.isPaused ? Color.secondary : .red)
                    .frame(minWidth: 36, maxWidth: 54, alignment: .trailing)
            } minimal: {
                logomark.frame(width: 22, height: 22)
            }
            .keylineTint(.red)
        }
    }

    private var logomark: some View {
        Image("Logomark")
            .renderingMode(.original)   // keep full color — was rendering as a gray (templated) blob
            .resizable()
            .scaledToFit()
    }

    private func dot(_ state: RecordingActivityAttributes.ContentState) -> some View {
        Circle().fill(state.isPaused ? Color.secondary : .red).frame(width: 7, height: 7)
    }

    /// Running timer when active; a frozen elapsed string when paused.
    @ViewBuilder private func timeText(_ state: RecordingActivityAttributes.ContentState) -> some View {
        if state.isPaused {
            Text(Self.formatted(state.elapsed)).monospacedDigit()
        } else {
            Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false)
                .monospacedDigit()
        }
    }

    private static func formatted(_ seconds: TimeInterval) -> String {
        let total = Int(max(0, seconds))
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
