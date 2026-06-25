import SwiftUI
import DembraneCore

/// The full Now-Recording screen — name, big timer, live waveform, pause/resume,
/// stop. "Done" collapses back to the mini bar (recording keeps going).
struct NowRecordingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()

                VStack(spacing: 6) {
                    Text(model.recordingName ?? "New recording")
                        .font(.title2.weight(.semibold))
                        .lineLimit(1)
                        .contentTransition(.opacity)
                    if let project = model.selectedProject {
                        Text(project.name).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal)

                Text(RecordingFormat.elapsed(model.recordingElapsed))
                    .font(.system(size: 64, weight: .light, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText())

                Label(model.isPaused ? "Paused" : "Recording", systemImage: "circle.fill")
                    .font(.subheadline)
                    .foregroundStyle(model.isPaused ? Color.secondary : Color.red)
                    .symbolEffect(.pulse, options: .repeating, isActive: !model.isPaused)

                WaveformView(levels: model.audioLevels)
                    .frame(height: 140)
                    .padding(.horizontal)

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
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        ForEach(model.availableInputs()) { input in
                            Button {
                                model.selectInput(uid: input.id)
                            } label: {
                                if input.id == model.currentInputUID {
                                    Label(input.name, systemImage: "checkmark")
                                } else {
                                    Text(input.name)
                                }
                            }
                        }
                    } label: {
                        Image(systemName: "mic")
                    }
                    .accessibilityLabel("Choose microphone")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDragIndicator(.visible)
    }
}
