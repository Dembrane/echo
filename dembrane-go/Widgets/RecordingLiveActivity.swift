import ActivityKit
import DembraneCore
import SwiftUI
import WidgetKit

/// The recording Live Activity: the dembrane logomark + a live timer, with a
/// red recording cue, across the Lock Screen and Dynamic Island presentations.
struct RecordingLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RecordingActivityAttributes.self) { context in
            // Lock Screen / banner
            HStack(spacing: 12) {
                logomark.frame(width: 30, height: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Recording").font(.headline)
                    Text("saving to \(context.state.projectName)")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                recordingDot
                timer(from: context.state.startedAt).font(.title3)
            }
            .padding()
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    logomark.frame(width: 26, height: 26)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    HStack(spacing: 5) {
                        recordingDot
                        timer(from: context.state.startedAt)
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    Image(systemName: "waveform")
                        .font(.title2)
                        .foregroundStyle(.red)
                        .symbolEffect(.variableColor.iterative, isActive: true)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text("saving to \(context.state.projectName)")
                        .font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
            } compactLeading: {
                logomark.frame(width: 22, height: 22)
            } compactTrailing: {
                timer(from: context.state.startedAt)
                    .foregroundStyle(.red)
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

    private var recordingDot: some View {
        Circle().fill(.red).frame(width: 7, height: 7)
    }

    private func timer(from start: Date) -> some View {
        Text(timerInterval: start...Date.distantFuture, countsDown: false)
            .monospacedDigit()
    }
}
