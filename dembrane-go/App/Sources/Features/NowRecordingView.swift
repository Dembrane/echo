import SwiftUI
import DembraneCore

/// The full Now-Recording screen — big timer, live waveform, pause/resume, stop.
/// Presented on record start and when tapping the mini bar; "Done" collapses
/// back to the mini bar (recording keeps going).
struct NowRecordingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 28) {
                Spacer()

                Text(RecordingFormat.elapsed(model.recordingElapsed))
                    .font(.system(size: 68, weight: .light, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(.primary)
                    .contentTransition(.numericText())

                Label(model.isPaused ? "Paused" : "Recording", systemImage: "circle.fill")
                    .font(.subheadline)
                    .foregroundStyle(model.isPaused ? Color.secondary : Color.red)
                    .symbolEffect(.pulse, options: .repeating, isActive: !model.isPaused)

                WaveformView(levels: model.audioLevels)
                    .frame(height: 140)
                    .padding(.horizontal)

                if let project = model.selectedProject {
                    Label("Saving to \(project.name)", systemImage: "folder")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                HStack(spacing: 44) {
                    Button {
                        model.isPaused ? model.resumeRecording() : model.pauseRecording()
                    } label: {
                        Image(systemName: model.isPaused ? "play.fill" : "pause.fill")
                            .font(.title)
                            .frame(width: 76, height: 76)
                    }
                    .buttonStyle(.glass)
                    .clipShape(.circle)
                    .accessibilityLabel(model.isPaused ? "Resume" : "Pause")

                    Button {
                        Task { await model.stopAndUpload() }
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.title)
                            .foregroundStyle(.white)
                            .frame(width: 76, height: 76)
                            .background(.red, in: .circle)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Stop and save")
                }

                Spacer()
            }
            .frame(maxWidth: .infinity)
            .navigationTitle("Recording")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDragIndicator(.visible)
    }
}
