import SwiftUI
import DembraneCore

/// Persistent capture indicator shown in the tab bar's bottom accessory while
/// recording — the system renders it on Liquid Glass.
struct RecordingMiniBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(BrandColor.cottonCandy)
                .frame(width: 10, height: 10)
            Text("Recording")
                .foregroundStyle(.primary)
            Spacer()
            Button {
                model.toggleRecording()
            } label: {
                Image(systemName: "stop.fill")
                    .foregroundStyle(BrandColor.royalBlue)
            }
            .accessibilityLabel("Stop recording")
        }
        .padding(.horizontal)
    }
}

#Preview {
    RecordingMiniBar().environment({
        let m = AppModel.makeMock(); m.isRecording = true; return m
    }())
}
