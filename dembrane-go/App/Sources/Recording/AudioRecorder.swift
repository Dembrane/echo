import AVFoundation
import Foundation

/// Records microphone audio to temporary m4a (AAC) files, rotating a new file
/// every `segmentEvery` seconds so each segment can be uploaded as it's
/// captured (the dembrane pipeline transcribes per chunk). Each finished
/// segment — including the final partial one on `stop()` — is delivered via
/// `onSegment`.
@MainActor
final class AudioRecorder {
    struct Segment: Sendable {
        let url: URL
        let index: Int
    }

    /// Called on the main actor as each segment finishes.
    var onSegment: ((Segment) -> Void)?

    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var currentURL: URL?
    private var index = 0

    private static let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 44_100,
        AVNumberOfChannelsKey: 1,
        AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
    ]

    func start(segmentEvery seconds: TimeInterval) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.allowBluetooth])
        try session.setActive(true)

        index = 0
        try beginSegment()
        timer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.rotate() }
        }
    }

    /// Stop recording; emits the final (partial) segment.
    func stop() {
        timer?.invalidate()
        timer = nil
        guard let rec = recorder, let url = currentURL else { return }
        rec.stop()
        let finished = Segment(url: url, index: index)
        recorder = nil
        currentURL = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        onSegment?(finished)
    }

    var isRecording: Bool { recorder != nil }

    private func beginSegment() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("dembrane-\(UUID().uuidString).m4a")
        let rec = try AVAudioRecorder(url: url, settings: Self.settings)
        guard rec.record() else { throw RecorderError.couldNotStart }
        recorder = rec
        currentURL = url
    }

    /// Close the current segment, emit it, and immediately start the next.
    private func rotate() {
        guard let rec = recorder, let url = currentURL else { return }
        rec.stop()
        let finished = Segment(url: url, index: index)
        index += 1
        try? beginSegment()
        onSegment?(finished)
    }

    enum RecorderError: Error { case couldNotStart }
}
