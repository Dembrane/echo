import SwiftUI
import DembraneCore

/// The Record sheet. Armed (not yet recording): a big Start button so capture
/// never begins by surprise. Recording: name, big timer, live waveform,
/// pause/resume, stop. "Done" collapses to the mini bar (recording continues).
struct NowRecordingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmDiscard = false
    @State private var showTranscript = false

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
            .navigationTitle(model.isRecording ? "" : "Record")
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
                Image(systemName: "record.circle.fill")
                    .font(.system(size: 120))
                    .foregroundStyle(.red)
                    .symbolRenderingMode(.hierarchical)
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
        VStack(spacing: 16) {
            // Heading: recording name, with the project left-aligned beneath it.
            VStack(alignment: .leading, spacing: 4) {
                Text(model.recordingName ?? "New recording")
                    .font(.title2.weight(.semibold)).lineLimit(2).contentTransition(.opacity)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let project = model.selectedProject {
                    Text(project.name).font(.subheadline).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal)

            liveTranscriptSection

            Spacer(minLength: 12)

            // Bottom cluster: status · waveform · timer · controls.
            VStack(spacing: 16) {
                Label(model.isPaused ? "Paused" : "Recording", systemImage: "circle.fill")
                    .font(.subheadline)
                    .foregroundStyle(model.isPaused ? Color.secondary : Color.red)
                    .symbolEffect(.pulse, options: .repeating, isActive: !model.isPaused)

                WaveformView(levels: model.audioLevels)
                    .frame(height: 72).padding(.horizontal)

                Text(RecordingFormat.elapsed(model.recordingElapsed))
                    .font(.system(size: 46, weight: .light, design: .rounded))
                    .monospacedDigit().contentTransition(.numericText())

                controlsRow
            }
            .padding(.bottom, 20)
        }
        .padding(.top, 8)
    }

    /// Live transcript — hidden by default, expandable. Lags behind by design
    /// (chunks transcribe server-side after upload).
    private var liveTranscriptSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.snappy) { showTranscript.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "text.alignleft")
                    Text("Live transcript")
                    Spacer()
                    Image(systemName: showTranscript ? "chevron.down" : "chevron.right").font(.caption)
                }
                .font(.subheadline).foregroundStyle(.secondary)
                .padding(.horizontal)
            }
            .buttonStyle(.plain)

            if showTranscript {
                ScrollView {
                    Text(model.liveTranscript.isEmpty
                         ? "Your transcript appears here as the recording is processed. It lags a little behind."
                         : model.liveTranscript)
                        .font(.callout)
                        .foregroundStyle(model.liveTranscript.isEmpty ? .tertiary : .primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(.horizontal)
                }
                .frame(maxHeight: 240)
            }
        }
    }

    private var controlsRow: some View {
        HStack(spacing: 44) {
            Button {
                model.isPaused ? model.resumeRecording() : model.pauseRecording()
            } label: {
                Image(systemName: model.isPaused ? "play.fill" : "pause.fill")
                    .font(.title).frame(width: 72, height: 72)
            }
            .buttonStyle(.glass).clipShape(.circle)
            .accessibilityLabel(model.isPaused ? "Resume" : "Pause")

            Button {
                Task { await model.stopAndUpload() }
            } label: {
                Image(systemName: "stop.fill")
                    .font(.title).foregroundStyle(.white)
                    .frame(width: 72, height: 72).background(.red, in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop and save")
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
