import SwiftUI
import DembraneCore

/// The persistent capture control in the tab bar's bottom accessory. Idle: a
/// prominent Record button. Recording: a Now-Playing-style mini bar that taps to
/// expand the Now-Recording screen. Adapts to the inline (collapsed) vs expanded
/// accessory placement so the timer never gets overlapped by the waveform.
struct RecordBar: View {
    @Environment(AppModel.self) private var model
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement

    var body: some View {
        if model.isRecording {
            recordingBar
        } else {
            recordButton
        }
    }

    private var recordButton: some View {
        Button {
            Task { await model.startRecording() }
        } label: {
            Label("Record", systemImage: "record.circle.fill")
                .font(.headline)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .tint(.red)
        .padding(.horizontal, 6)
    }

    private var recordingBar: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(.red)
                .frame(width: 9, height: 9)
                .opacity(model.isPaused ? 0.35 : 1)

            if placement == .inline {
                Text(RecordingFormat.elapsed(model.recordingElapsed))
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.primary)
                    .fixedSize()
                Spacer(minLength: 0)
            } else {
                WaveformView(levels: model.audioLevels)
                    .frame(maxWidth: .infinity)
                    .frame(height: 22)
                Text(RecordingFormat.elapsed(model.recordingElapsed))
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.primary)
                    .fixedSize()
            }

            Button {
                model.isPaused ? model.resumeRecording() : model.pauseRecording()
            } label: {
                Image(systemName: model.isPaused ? "play.fill" : "pause.fill")
                    .font(.title3)
                    .foregroundStyle(BrandColor.royalBlue)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.isPaused ? "Resume" : "Pause")
        }
        .padding(.horizontal, 14)
        .contentShape(Rectangle())
        .onTapGesture { model.showRecordingScreen = true }
    }
}

enum RecordingFormat {
    static func elapsed(_ t: TimeInterval) -> String {
        let total = Int(t)
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}
