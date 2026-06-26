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
    private var rotationSuspended = false
    private var interruptionObserver: NSObjectProtocol?

    private static let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 44_100,
        AVNumberOfChannelsKey: 1,
        AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
    ]

    func start(segmentEvery seconds: TimeInterval) throws {
        let session = AVAudioSession.sharedInstance()
        // .mixWithOthers so another app starting audio doesn't interrupt/stop our
        // recording (robustness — capture must survive app-switching). Hard
        // interruptions (calls) are still handled via interruptionNotification.
        try session.setCategory(.playAndRecord, mode: .spokenAudio,
                                options: [.allowBluetoothHFP, .mixWithOthers])
        try session.setActive(true)

        segmentSeconds = seconds
        index = 0
        isPaused = false
        rotationSuspended = false
        observeInterruptions()
        try beginSegment()
        startRotationTimer()
    }

    /// Stop recording; emits the final (partial) segment.
    func stop() {
        timer?.invalidate()
        timer = nil
        isPaused = false
        rotationSuspended = false
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
            self.interruptionObserver = nil
        }
        guard let rec = recorder, let url = currentURL else { return }
        rec.stop()
        let finished = Segment(url: url, index: index)
        recorder = nil
        currentURL = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        onSegment?(finished)
    }

    /// Backgrounding: keep ONE continuous recorder running (no stop/start), so
    /// audio never drops. Rotating in the background is unreliable (starting a
    /// fresh AVAudioRecorder can fail/gap) — that was the "goes silent, recovers
    /// at the 30s tick" bug. We just stop emitting/uploading segments until the
    /// app is foreground again.
    func suspendRotation() {
        guard recorder != nil, !rotationSuspended else { return }
        rotationSuspended = true
        timer?.invalidate()
        timer = nil
    }

    /// Foreground: emit whatever was captured while suspended (one big segment →
    /// uploads now), then resume the normal 30s rotation.
    func resumeRotation() {
        guard recorder != nil, rotationSuspended else { return }
        rotationSuspended = false
        rotate()
        startRotationTimer()
    }

    private func observeInterruptions() {
        if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let info = note.userInfo,
                  let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            let shouldResume = (info[AVAudioSessionInterruptionOptionKey] as? UInt)
                .map { AVAudioSession.InterruptionOptions(rawValue: $0).contains(.shouldResume) } ?? false
            MainActor.assumeIsolated { self?.onInterruption(type: type, shouldResume: shouldResume) }
        }
    }

    /// When an interruption ends (call, Siri, another app's audio), reactivate
    /// the session and resume recording so capture continues seamlessly.
    private func onInterruption(type: AVAudioSession.InterruptionType, shouldResume: Bool) {
        guard type == .ended, shouldResume, recorder != nil, !isPaused else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        recorder?.record()
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
