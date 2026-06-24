import AVFoundation
import Foundation

/// Records microphone audio to a temporary m4a (AAC) file — the format the
/// dembrane upload pipeline accepts.
@MainActor
final class AudioRecorder {
    private var recorder: AVAudioRecorder?
    private var startedAt: Date?
    private var fileURL: URL?

    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.allowBluetooth])
        try session.setActive(true)

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("dembrane-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        let rec = try AVAudioRecorder(url: url, settings: settings)
        guard rec.record() else { throw RecorderError.couldNotStart }
        recorder = rec
        fileURL = url
        startedAt = Date()
    }

    /// Stops and returns the recorded file + its duration, or nil if idle.
    func stop() -> (url: URL, duration: TimeInterval)? {
        guard let rec = recorder, let url = fileURL, let start = startedAt else { return nil }
        rec.stop()
        recorder = nil
        fileURL = nil
        startedAt = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        return (url, Date().timeIntervalSince(start))
    }

    enum RecorderError: Error { case couldNotStart }
}
