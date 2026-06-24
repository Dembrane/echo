import SwiftUI
import DembraneCore

struct RecordView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            VStack(spacing: 28) {
                Spacer()
                recordButton
                Text(model.isRecording ? "Recording…" : "Tap to record")
                    .font(.title2)
                    .foregroundStyle(BrandColor.graphite)
                Label("Saving to: \(model.defaultProjectName)", systemImage: "folder")
                    .font(.callout)
                    .foregroundStyle(BrandColor.graphite.opacity(0.6))
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(BrandColor.parchment)
            .navigationTitle("Record")
        }
    }

    private var recordButton: some View {
        Button {
            model.toggleRecording()
        } label: {
            Image(systemName: model.isRecording ? "stop.fill" : "mic.fill")
                .font(.system(size: 56))
                .foregroundStyle(.white)
                .frame(width: 144, height: 144)
        }
        .glassEffect(.regular.tint(BrandColor.royalBlue).interactive(), in: .circle)
        .accessibilityLabel(model.isRecording ? "Stop recording" : "Start recording")
    }
}

#Preview {
    RecordView().environment(AppModel.makeMock())
}
