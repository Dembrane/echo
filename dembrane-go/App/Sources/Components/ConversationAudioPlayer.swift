import SwiftUI
import AVFoundation
import MediaPlayer
import DembraneCore

/// Plays a conversation's merged audio with lock-screen / background support:
/// AVAudioSession `.playback` (keeps going when the app is backgrounded or the
/// phone is locked — `audio` background mode is in Info.plist) plus Now Playing
/// info and remote commands so the Lock Screen / Control Center controls work.
@MainActor
@Observable
final class ConversationAudioPlayer {
    enum Phase: Equatable { case idle, loading, ready, failed }
    private(set) var phase: Phase = .idle
    var isPlaying = false
    var currentTime: Double = 0
    var duration: Double = 0

    private var player: AVPlayer?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var title = "Recording"

    /// Load once. Safe to call repeatedly — it no-ops after the first URL.
    func prepare(url: URL, title: String) {
        guard player == nil else { return }
        self.title = title
        phase = .loading
        let item = AVPlayerItem(url: url)
        let p = AVPlayer(playerItem: item)
        p.allowsExternalPlayback = true
        player = p
        timeObserver = p.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main
        ) { [weak self] time in
            guard let self else { return }
            self.currentTime = time.seconds.isFinite ? time.seconds : 0
            self.updateNowPlaying()
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self] _ in Task { @MainActor in self?.handleEnd() } }
        setupRemoteCommands()
        Task { await loadDuration(item) }
    }

    private func loadDuration(_ item: AVPlayerItem) async {
        if let d = try? await item.asset.load(.duration), d.seconds.isFinite, d.seconds > 0 {
            duration = d.seconds
        }
        phase = .ready
        updateNowPlaying()
    }

    func toggle() { isPlaying ? pause() : play() }

    func play() {
        guard let player else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio)
        try? session.setActive(true)
        player.play()
        isPlaying = true
        updateNowPlaying()
    }

    func pause() {
        player?.pause()
        isPlaying = false
        updateNowPlaying()
    }

    func seek(to seconds: Double) {
        let target = max(0, duration > 0 ? min(seconds, duration) : seconds)
        player?.seek(to: CMTime(seconds: target, preferredTimescale: 600))
        currentTime = target
        updateNowPlaying()
    }

    func skip(_ delta: Double) { seek(to: currentTime + delta) }

    private func handleEnd() {
        player?.pause()
        isPlaying = false
        seek(to: 0)
    }

    /// Call when the detail view goes away: stop audio and release the session.
    func teardown() {
        if let timeObserver { player?.removeTimeObserver(timeObserver) }
        timeObserver = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        player?.pause()
        player = nil
        isPlaying = false
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        let c = MPRemoteCommandCenter.shared()
        [c.playCommand, c.pauseCommand, c.togglePlayPauseCommand, c.changePlaybackPositionCommand]
            .forEach { $0.removeTarget(nil) }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func setupRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in Task { @MainActor in self?.play() }; return .success }
        c.pauseCommand.addTarget { [weak self] _ in Task { @MainActor in self?.pause() }; return .success }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in Task { @MainActor in self?.toggle() }; return .success }
        c.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            Task { @MainActor in self?.seek(to: e.positionTime) }
            return .success
        }
    }

    private func updateNowPlaying() {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: "dembrane go",
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentTime,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
        ]
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}

/// Compact transport for the conversation detail sheet.
struct ConversationAudioPlayerView: View {
    @Bindable var player: ConversationAudioPlayer
    @State private var scrubbing = false
    @State private var scrubValue = 0.0

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 28) {
                Button { player.skip(-15) } label: { Image(systemName: "gobackward.15") }
                    .font(.title2)
                Button { player.toggle() } label: {
                    Image(systemName: player.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 48))
                }
                Button { player.skip(15) } label: { Image(systemName: "goforward.15") }
                    .font(.title2)
            }
            .tint(BrandColor.royalBlue)
            .symbolRenderingMode(.hierarchical)

            if player.duration > 0 {
                Slider(value: Binding(
                    get: { scrubbing ? scrubValue : player.currentTime },
                    set: { scrubValue = $0 }
                ), in: 0...player.duration, onEditingChanged: { editing in
                    scrubbing = editing
                    if !editing { player.seek(to: scrubValue) }
                })
                .tint(BrandColor.royalBlue)
                HStack {
                    Text(Self.time(scrubbing ? scrubValue : player.currentTime))
                    Spacer()
                    Text(Self.time(player.duration))
                }
                .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
            } else if player.phase == .loading {
                ProgressView().padding(.vertical, 4)
            }
        }
        .padding()
        .frame(maxWidth: .infinity)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private static func time(_ s: Double) -> String {
        let v = Int(s.isFinite ? max(0, s) : 0)
        return String(format: "%d:%02d", v / 60, v % 60)
    }
}
