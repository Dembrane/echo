import AVFoundation
import Foundation

/// Records microphone audio to temporary m4a (AAC) files, rotating a new file
/// every `segmentEvery` seconds so each segment can be uploaded as it's
/// captured (the dembrane pipeline transcribes per chunk). Each finished
/// segment — including the final partial one on `stop()` — is delivered via
/// `onSegment`. Metering is enabled for a live waveform.
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
    private var segmentSeconds: TimeInterval = 30
    private(set) var isPaused = false

    private static let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 44_100,
        AVNumberOfChannelsKey: 1,
        AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
    ]

    func start(segmentEvery seconds: TimeInterval) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.allowBluetoothHFP])
        try session.setActive(true)

        segmentSeconds = seconds
        index = 0
        isPaused = false
        try beginSegment()
        startRotationTimer()
    }

    /// Stop recording; emits the final (partial) segment.
    func stop() {
        timer?.invalidate()
        timer = nil
        isPaused = false
        guard let rec = recorder, let url = currentURL else { return }
        rec.stop()
        let finished = Segment(url: url, index: index)
        recorder = nil
        currentURL = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        onSegment?(finished)
    }

    func pause() {
        guard let rec = recorder, !isPaused else { return }
        rec.pause()
        timer?.invalidate()
        timer = nil
        isPaused = true
    }

    func resume() {
        guard let rec = recorder, isPaused else { return }
        rec.record()
        isPaused = false
        startRotationTimer()
    }

    var isRecording: Bool { recorder != nil }

    struct Input: Identifiable, Sendable, Hashable {
        let id: String      // port UID
        let name: String
    }

    func availableInputs() -> [Input] {
        (AVAudioSession.sharedInstance().availableInputs ?? [])
            .map { Input(id: $0.uid, name: $0.portName) }
    }

    var currentInputUID: String? {
        AVAudioSession.sharedInstance().currentRoute.inputs.first?.uid
    }

    func selectInput(uid: String) {
        guard let port = AVAudioSession.sharedInstance().availableInputs?.first(where: { $0.uid == uid })
        else { return }
        try? AVAudioSession.sharedInstance().setPreferredInput(port)
    }

    /// Current mic level, normalized 0…1, for the waveform.
    func currentLevel() -> Float {
        guard let rec = recorder, rec.isRecording, !isPaused else { return 0 }
        rec.updateMeters()
        let power = rec.averagePower(forChannel: 0)   // dBFS, ~-60 (quiet) … 0 (loud)
        return max(0, min(1, (power + 55) / 55))
    }

    private func startRotationTimer() {
        // .common mode so segment rotation keeps firing while the user scrolls /
        // navigates (default-mode timers pause during scroll tracking, which would
        // stall chunk uploads).
        let t = Timer(timeInterval: segmentSeconds, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.rotate() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func beginSegment() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("dembrane-\(UUID().uuidString).m4a")
        let rec = try AVAudioRecorder(url: url, settings: Self.settings)
        rec.isMeteringEnabled = true
        guard rec.record() else { throw RecorderError.couldNotStart }
        recorder = rec
        currentURL = url
    }

    /// Close the current segment, emit it, and immediately start the next. The
    /// next recorder is *prepared* before the current one stops so the capture
    /// gap at the 30s boundary is as small as AVAudioRecorder allows. (Fully
    /// gapless would need AVAudioEngine + a continuous tap — a bigger change.)
    private func rotate() {
        guard let rec = recorder, let url = currentURL else { return }
        let nextURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("dembrane-\(UUID().uuidString).m4a")
        let next = try? AVAudioRecorder(url: nextURL, settings: Self.settings)
        next?.isMeteringEnabled = true
        next?.prepareToRecord()

        rec.stop()
        let finished = Segment(url: url, index: index)
        index += 1

        if let next, next.record() {
            recorder = next
            currentURL = nextURL
        } else {
            try? beginSegment()   // fallback if the prepared recorder failed
        }
        onSegment?(finished)
    }

    enum RecorderError: Error { case couldNotStart }
}
