import SwiftUI
import DembraneCore

struct RecordView: View {
    @Environment(AppModel.self) private var model
    @State private var showProjectPicker = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 28) {
                Spacer()
                recordButton
                Text(model.isRecording ? "Recording…" : "Tap to record")
                    .font(.title2)
                    .foregroundStyle(BrandColor.graphite)
                Button {
                    showProjectPicker = true
                } label: {
                    Label("Saving to: \(model.selectedProject?.name ?? model.defaultProjectName)", systemImage: "folder")
                        .font(.callout)
                        .foregroundStyle(BrandColor.graphite.opacity(0.7))
                }
                .disabled(model.isRecording)
                if let status = model.statusMessage {
                    Text(status)
                        .font(.callout)
                        .foregroundStyle(BrandColor.royalBlue)
                }
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(BrandColor.parchment)
            .navigationTitle("Record")
            .sheet(isPresented: $showProjectPicker) {
                ProjectPicker { model.selectProject($0) }
            }
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
