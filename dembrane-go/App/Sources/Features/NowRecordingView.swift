import SwiftUI
import DembraneCore

/// The Record sheet. Armed (not yet recording): a big Start button so capture
/// never begins by surprise. Recording: name, big timer, live waveform,
/// pause/resume, stop. "Done" collapses to the mini bar (recording continues).
struct NowRecordingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmDiscard = false

    var body: some View {
        NavigationStack {
            Group {
                if model.isRecording {
                    recordingContent
                } else {
                    armedContent
                }
            }
            .frame(maxWidth: .infinity)
            .navigationTitle(model.isRecording ? "Recording" : "Record")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if model.isRecording {
                    ToolbarItem(placement: .topBarLeading) { micMenu }
                    ToolbarItem(placement: .topBarTrailing) { moreMenu }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(model.isRecording ? "Done" : "Cancel") { dismiss() }
                }
            }
            .confirmationDialog("Discard this recording?",
                                isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Discard", role: .destructive) {
                    model.discardRecording()
                    dismiss()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This deletes the audio without saving it.")
            }
        }
        .presentationDragIndicator(.visible)
        // Haptics for the core action: a firm cue on start/stop, a light tick on pause/resume.
        .sensoryFeedback(trigger: model.isRecording) { _, recording in recording ? .start : .stop }
        .sensoryFeedback(.selection, trigger: model.isPaused)
    }

    // MARK: Armed (tap to start)

    private var armedContent: some View {
        VStack(spacing: 20) {
            Spacer()
            Button {
                Task { await model.startRecording() }
            } label: {
                Image(systemName: "mic.fill")
                    .font(.system(size: 52))
                    .foregroundStyle(.white)
                    .frame(width: 132, height: 132)
                    .background(.red, in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Start recording")

            Text("Tap to record").font(.headline)
            if let project = model.selectedProject {
                Label("Saving to \(project.name)", systemImage: "folder")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    // MARK: Recording

    private var recordingContent: some View {
        VStack(spacing: 24) {
            Spacer()

            VStack(spacing: 6) {
                Text(model.recordingName ?? "New recording")
                    .font(.title2.weight(.semibold)).lineLimit(1).contentTransition(.opacity)
                if let project = model.selectedProject {
                    Text(project.name).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal)

            Text(RecordingFormat.elapsed(model.recordingElapsed))
                .font(.system(size: 64, weight: .light, design: .rounded))
                .monospacedDigit().contentTransition(.numericText())

            Label(model.isPaused ? "Paused" : "Recording", systemImage: "circle.fill")
                .font(.subheadline)
                .foregroundStyle(model.isPaused ? Color.secondary : Color.red)
                .symbolEffect(.pulse, options: .repeating, isActive: !model.isPaused)

            WaveformView(levels: model.audioLevels)
                .frame(height: 140).padding(.horizontal)

            Spacer()

            HStack(spacing: 44) {
                Button {
                    model.isPaused ? model.resumeRecording() : model.pauseRecording()
                } label: {
                    Image(systemName: model.isPaused ? "play.fill" : "pause.fill")
                        .font(.title).frame(width: 76, height: 76)
                }
                .buttonStyle(.glass).clipShape(.circle)
                .accessibilityLabel(model.isPaused ? "Resume" : "Pause")

                Button {
                    Task { await model.stopAndUpload() }
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.title).foregroundStyle(.white)
                        .frame(width: 76, height: 76).background(.red, in: .circle)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop and save")
            }

            Spacer()
        }
    }

    private var moreMenu: some View {
        Menu {
            Button(role: .destructive) { confirmDiscard = true } label: {
                Label("Discard recording", systemImage: "trash")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("More options")
    }

    private var micMenu: some View {
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
}
