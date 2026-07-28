import SwiftUI
import AVFoundation
import WatchConnectivity

@main
struct DembraneGoWatchApp: App {
    var body: some Scene {
        WindowGroup { WatchRecordView() }
    }
}

struct WatchRecordView: View {
    @State private var model = WatchCaptureModel()

    var body: some View {
        VStack(spacing: 14) {
            Button {
                model.toggle()
            } label: {
                Image(systemName: model.isRecording ? "stop.fill" : "mic.fill")
                    .font(.title)
                    .foregroundStyle(.white)
                    .frame(width: 72, height: 72)
                    .background(.red, in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.isRecording ? "Stop and send" : "Record")

            Text(model.status.isEmpty ? "Tap to record" : model.status)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }
}

/// Records on the watch and ships the file to the iPhone via WatchConnectivity,
/// where the phone uploads it to the active project (source GO_WATCH).
@MainActor
@Observable
final class WatchCaptureModel {
    var isRecording = false
    var status = ""

    private let transfer = WatchTransfer()
    private var recorder: AVAudioRecorder?
    private var fileURL: URL?

    init() { transfer.activate() }

    func toggle() { isRecording ? stop() : start() }

    func start() {
        Task {
            guard await AVAudioApplication.requestRecordPermission() else {
                status = "Microphone access is off."; return
            }
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.record, mode: .default)
                try session.setActive(true)
                let url = FileManager.default.temporaryDirectory
                    .appendingPathComponent("watch-\(UUID().uuidString).m4a")
                let rec = try AVAudioRecorder(url: url, settings: [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVSampleRateKey: 44_100,
                    AVNumberOfChannelsKey: 1,
                    AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
                ])
                guard rec.record() else { status = "Couldn't start."; return }
                recorder = rec
                fileURL = url
                isRecording = true
                status = "Recording…"
            } catch {
                status = "Couldn't start."
            }
        }
    }

    func stop() {
        recorder?.stop()
        recorder = nil
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false)
        guard let url = fileURL else { return }
        fileURL = nil
        status = transfer.send(url) ? "Sent to iPhone." : "Saved (no iPhone link)."
    }
}

/// Plain WCSession owner — keeps the delegate off the @Observable model.
final class WatchTransfer: NSObject, WCSessionDelegate {
    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    @discardableResult
    func send(_ url: URL) -> Bool {
        guard WCSession.isSupported() else { return false }
        WCSession.default.transferFile(url, metadata: ["source": "GO_WATCH"])
        return true
    }

    func session(_ session: WCSession,
                 activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {}
}
