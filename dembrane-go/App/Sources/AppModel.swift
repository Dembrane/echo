import Foundation
import AVFoundation
import ActivityKit
import Observation
import UIKit
import DembraneCore

extension Notification.Name {
    /// Posted when a token refresh fails (session truly dead) — the app signs out.
    static let dembraneSessionExpired = Notification.Name("dembrane.go.sessionExpired")
}

/// App-wide state. Real stack uses the Keychain session + live API client;
/// previews/tests use an in-memory session + mock API.
@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable { case loading, signedOut, signedIn }
    enum AppTab: Hashable, Sendable { case home, record, conversations, ask }

    // UI state
    var phase: Phase = .loading
    var selectedTab: AppTab = .home
    var environment: AppEnvironment
    var trainingOptIn = false
    let defaultProjectName = "Go Recordings"
    var isRecording = false
    var isPaused = false
    var recordingStartedAt: Date?
    var recordingElapsed: TimeInterval = 0
    var recordingName: String?
    var audioLevels: [Float] = []
    var showRecordingScreen = false
    /// Drives the "Saving… / Saved" confirmation banner after a recording stops.
    enum SaveState: Equatable { case idle, saving, saved, failed }
    var saveState: SaveState = .idle
    /// Set when a "Start Recording" intent fires before the app is ready; consumed once ready.
    private var pendingStartRecording = false
    var loginError: String?
    var isSigningIn = false
    var needsOTP = false        // 2FA: show the one-time-code field
    var statusMessage: String?
    var isRegistering = false
    var registerError: String?
    var registrationSentTo: String?
    var pendingAskConversationId: String?
    var pendingAskQuery: String?
    var showOnboarding = false

    // Loaded data
    var me: Me?
    var workspaces: [Workspace] = []
    var allProjects: [WorkspaceProject] = []
    var selectedProject: Project?
    var conversations: [Conversation] = []
    var conversationsLoading = false
    var conversationsError = false
    var didLoadConversationsOnce = false
    /// Free-tier upload gating for the active workspace (informational only).
    var workspaceUsage: WorkspaceUsage?
    var uploadsLocked: Bool { workspaceUsage?.uploadsLocked == true || workspaceUsage?.overCapActive == true }

    /// The conversation currently being recorded (so its list row opens the
    /// Now-Recording screen instead of the transcript detail). Nil when idle.
    var activeRecordingConversationId: String? { isRecording ? captureConversationId : nil }

    /// Transcript captured so far during the live recording (polled from chunks;
    /// lags ~30–60s behind because chunks transcribe server-side after upload).
    var liveTranscript = ""
    private var transcriptPollTask: Task<Void, Never>?
    static let waveformBarCount = 48

    // Ask (chat) state
    var askConversationIds: Set<String> = []
    var askMessages: [AskMessage] = []
    var askStreaming = false
    var askError: String?
    private var currentChatId: String?

    private static let selectedProjectKey = "dembrane.go.selectedProject"   // full Project JSON
    private static let didOnboardKey = "dembrane.go.didOnboard"
    private static let environmentKey = "dembrane.go.environment"

    private let sessionManager: SessionManager
    private var auth: AuthService
    private var api: DembraneAPIClientProtocol
    private var chatService: ChatService
    private let uploader: ParticipantUploadClient
    private let recorder = AudioRecorder()
    private let locationNamer = LocationNamer()
    private let watchReceiver = WatchConnectivityManager()
    private var liveActivity: Activity<RecordingActivityAttributes>?

    // Chunked-capture state
    private var captureConversationId: String?
    private var captureStart: Date?
    private var pendingSegments: [AudioRecorder.Segment] = []
    private var chunkUploads: [Task<Void, Never>] = []
    private var initiateTask: Task<String?, Never>?
    private let chunkSeconds: TimeInterval = 30
    private var meterTimer: Timer?

    // Local-first durable storage: segments are written to disk and survive an
    // app kill; a recording is removed only once fully pushed to dembrane.
    private let store = LocalRecordingStore.shared
    private var activeLocalId: String?
    /// Recordings captured but not yet fully uploaded (failed/interrupted/killed).
    var pendingRecordings: [LocalRecording] = []
    var uploadingRecordingIds: Set<String> = []
    private var pausedTotal: TimeInterval = 0
    private var lastPauseAt: Date?

    init(environment: AppEnvironment,
         sessionManager: SessionManager,
         auth: AuthService,
         api: DembraneAPIClientProtocol) {
        self.environment = environment
        self.sessionManager = sessionManager
        self.auth = auth
        self.api = api
        self.uploader = ParticipantUploadClient(env: environment)
        self.chatService = ChatService(env: environment,
                                       tokenProvider: { await sessionManager.accessToken() })
    }

    /// Real app stack: Keychain-backed session + live API client (with a
    /// refresh-on-401 retry).
    convenience init() {
        let env = AppEnvironment(rawValue: UserDefaults.standard.string(forKey: Self.environmentKey) ?? "") ?? .default
        let sm = SessionManager(store: makeSessionStore())
        let auth = AuthService(env: env, sessionManager: sm)
        let api = LiveAPIClient(
            env: env,
            tokenProvider: { await sm.accessToken() },
            onUnauthorized: { await Self.refreshOrExpire(auth) })
        self.init(environment: env, sessionManager: sm, auth: auth, api: api)
    }

    /// Preview/test stack: in-memory session + (by default) mock API.
    static func makeMock(api: DembraneAPIClientProtocol = MockAPIClient()) -> AppModel {
        let sm = SessionManager(store: InMemorySessionStore())
        let auth = AuthService(env: .echoNext, sessionManager: sm)
        return AppModel(environment: .echoNext, sessionManager: sm, auth: auth, api: api)
    }

    /// The API client's 401 handler: try to refresh; if that fails the session is
    /// dead, so broadcast session-expired (the app signs out) and report failure.
    /// Centralizes auth handling so EVERY authed call recovers the same way.
    nonisolated private static func refreshOrExpire(_ auth: AuthService) async -> Bool {
        if (try? await auth.refresh()) == true { return true }
        NotificationCenter.default.post(name: .dembraneSessionExpired, object: nil)
        return false
    }

    func start() async {
        #if DEBUG
        // Dev-only: point the sim at a chosen backend (default is production).
        if let envName = ProcessInfo.processInfo.environment["DEMBRANE_DEV_ENV"],
           let devEnv = AppEnvironment(rawValue: envName) {
            setEnvironment(devEnv)
        }
        #endif
        // Reconcile: end any Live Activity left from a previous session. Recording
        // state isn't restored across launches, so a still-running Dynamic Island
        // is always stale — this fixes the "keeps counting up forever" bug. Awaited
        // before any relaunch-triggered recording so we don't kill a fresh one.
        for activity in Activity<RecordingActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }

        // Any authed call whose token refresh fails broadcasts this → sign out.
        NotificationCenter.default.addObserver(
            forName: .dembraneSessionExpired, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.phase == .signedIn else { return }
                await self.signOut()
            }
        }

        // Listen for audio transferred from the Watch app and upload it.
        watchReceiver.onReceiveFile = { [weak self] url in
            Task { @MainActor in await self?.uploadWatchFile(url) }
        }
        watchReceiver.activate()

        // Restore the last project instantly from disk so recording is never
        // blocked on "no project to save to" while the network catches up.
        if selectedProject == nil { selectedProject = restoredProject() }
        if await sessionManager.isAuthenticated() {
            phase = .signedIn
            await loadData()
            applyDevTab()
        } else {
            #if DEBUG
            // Dev-only: auto sign-in from env-var creds for simulator verification.
            let env = ProcessInfo.processInfo.environment
            if let email = env["DEMBRANE_DEV_EMAIL"], let password = env["DEMBRANE_DEV_PASSWORD"],
               !email.isEmpty, !password.isEmpty {
                await signIn(email: email, password: password)
                applyDevTab()
            } else {
                phase = .signedOut
            }
            #else
            phase = .signedOut
            #endif
        }
        #if DEBUG
        await maybeDevAutoRecord()
        await maybeDevAutoAsk()
        #endif
        processPendingRecordingIfReady()   // honor a "Start Recording" intent fired at launch
        await refreshPendingRecordings()   // recover any recordings left on disk (kills/failures)
    }

    /// Called when the app becomes active: pick up a "Start Recording" signal
    /// from the Action Button / Siri / Shortcuts and begin capture.
    func handleLaunchIntents() {
        if AppGroup.consumeStartRecordingSignal() { pendingStartRecording = true }
        processPendingRecordingIfReady()
    }

    /// Returning to the foreground while recording: resume segment rotation (which
    /// emits + uploads everything captured while backgrounded), flush any buffered
    /// segments, and refresh the list so the recording is reflected.
    func reconcileOnForeground() {
        guard isRecording else { return }
        recorder.resumeRotation()
        if let id = captureConversationId { flushPendingSegments(conversationId: id) }
        Task { await loadConversations() }
    }

    /// Leaving the foreground while recording: stop rotating but keep capturing to
    /// one continuous file (no stop/start in the background → no dropouts).
    func handleBackgrounded() {
        guard isRecording else { return }
        recorder.suspendRotation()
    }

    /// Starts capture if an intent asked for it and we're ready (project loaded,
    /// not already recording). Held until `start()` restores the project, so a
    /// cold launch from the Action Button still works.
    private func processPendingRecordingIfReady() {
        guard pendingStartRecording, !isRecording, selectedProject != nil else { return }
        pendingStartRecording = false
        Task { await startRecording() }
    }

    /// Dev-only: auto-send an Ask question to verify chat streaming headlessly
    /// (env DEMBRANE_DEV_ASK="your question").
    private func maybeDevAutoAsk() async {
        #if DEBUG
        guard phase == .signedIn,
              let question = ProcessInfo.processInfo.environment["DEMBRANE_DEV_ASK"],
              !question.isEmpty
        else { return }
        selectedTab = .ask
        await sendAsk(question)
        #endif
    }

    /// Dev-only: record a short clip and upload it to verify the pipeline in the
    /// simulator headlessly (env DEMBRANE_DEV_AUTORECORD=<seconds>).
    private func maybeDevAutoRecord() async {
        guard phase == .signedIn,
              let seconds = ProcessInfo.processInfo.environment["DEMBRANE_DEV_AUTORECORD"].flatMap(Double.init)
        else { return }
        await startRecording()
        try? await Task.sleep(for: .seconds(seconds))
        await stopAndUpload()
    }

    private func applyDevTab() {
        #if DEBUG
        switch ProcessInfo.processInfo.environment["DEMBRANE_DEV_TAB"] {
        case "home": selectedTab = .home
        case "conversations": selectedTab = .conversations
        case "ask": selectedTab = .ask
        default: break
        }
        #endif
    }

    func signIn(email: String, password: String, otp: String? = nil) async {
        loginError = nil
        isSigningIn = true
        defer { isSigningIn = false }
        do {
            _ = try await auth.login(email: email, password: password, otp: otp)
            needsOTP = false
            phase = .signedIn
            await loadData()
        } catch AuthError.otpRequired {
            // 2FA: reveal the code field. If a code was already entered, it was wrong.
            if needsOTP, otp?.isEmpty == false {
                loginError = "That code didn't work — try again."
            }
            needsOTP = true
            if phase == .loading { phase = .signedOut }
        } catch AuthError.invalidCredentials {
            loginError = "That email or password didn't work."
            needsOTP = false
            if phase == .loading { phase = .signedOut }
        } catch {
            NSLog("dembrane-go sign-in failed: \(error)")
            loginError = "Couldn't sign in. Check your connection and try again."
            if phase == .loading { phase = .signedOut }
        }
    }

    /// Switch backend environment (login screen). Rebuilds the auth + API
    /// clients for the new env and persists the choice.
    func setEnvironment(_ env: AppEnvironment) {
        guard env != environment else { return }
        environment = env
        UserDefaults.standard.set(env.rawValue, forKey: Self.environmentKey)
        let newAuth = AuthService(env: env, sessionManager: sessionManager)
        auth = newAuth
        api = LiveAPIClient(
            env: env,
            tokenProvider: { [sessionManager] in await sessionManager.accessToken() },
            onUnauthorized: { await Self.refreshOrExpire(newAuth) })
        chatService = ChatService(env: env,
                                  tokenProvider: { [sessionManager] in await sessionManager.accessToken() })
        AppGroup.write(projectId: selectedProject?.id, projectName: selectedProject?.name, environment: env)   // keep the Share Extension in sync
    }

    func register(firstName: String, lastName: String, email: String, password: String) async {
        registerError = nil
        isRegistering = true
        defer { isRegistering = false }
        let verificationURL = environment.dashboardBaseURL.appendingPathComponent("verify-email").absoluteString
        do {
            try await auth.register(email: email, password: password,
                                    firstName: firstName, lastName: lastName,
                                    verificationURL: verificationURL)
            registrationSentTo = email
        } catch {
            registerError = "Couldn't create your account. Please try again."
        }
    }

    func signOut() async {
        await auth.logout()
        me = nil
        workspaces = []
        allProjects = []
        selectedProject = nil
        conversations = []
        phase = .signedOut
    }

    func toggleRecording() {
        if isRecording {
            Task { await stopAndUpload() }
        } else {
            Task { await startRecording() }
        }
    }

    func startRecording() async {
        guard await AVAudioApplication.requestRecordPermission() else {
            statusMessage = "Microphone access is off — enable it in Settings."
            return
        }
        guard let projectId = selectedProject?.id else {
            statusMessage = "No project to save to yet."
            return
        }

        captureStart = Date()
        recordingStartedAt = captureStart
        captureConversationId = nil
        pendingSegments = []
        chunkUploads = []
        recorder.onSegment = { [weak self] segment in self?.handleSegment(segment) }

        // Open a durable local recording first — segments are written here so the
        // audio survives even if upload fails or the app is force-quit.
        let displayName = Date().formatted(date: .abbreviated, time: .shortened)
        recordingName = displayName
        let local = await store.begin(projectId: projectId, displayName: displayName, createdAt: captureStart ?? Date())
        activeLocalId = local.id
        let segmentDir = await store.directoryURL(local.id)

        isPaused = false
        pausedTotal = 0
        lastPauseAt = nil
        audioLevels = Array(repeating: 0, count: Self.waveformBarCount)   // fixed-width buffer (smooth)
        recordingElapsed = 0
        do {
            // Start capturing immediately — don't wait on the network.
            try recorder.start(segmentEvery: chunkSeconds, in: segmentDir)
            isRecording = true
            statusMessage = nil
            showRecordingScreen = true        // open the Now-Recording screen
            startMeterTimer()
            startLiveActivity()
            startLiveTranscriptPolling()
        } catch {
            statusMessage = "Couldn't start recording."
            await store.remove(local.id)
            activeLocalId = nil
            return
        }

        // Create the conversation in parallel; flush buffered segments once ready.
        // Retry initiate with backoff — a transient failure (or being backgrounded
        // before it completes) must NOT lose the recording. Segments keep buffering
        // in pendingSegments until the conversation id resolves, then flush.
        initiateTask = Task { [uploader] in
            for attempt in 0..<12 {
                if Task.isCancelled { return nil }
                if let id = try? await uploader.startConversation(projectId: projectId, displayName: displayName) {
                    return id
                }
                try? await Task.sleep(for: .seconds(min(Double(attempt + 1) * 2, 15)))
            }
            return nil
        }
        Task {
            let id = await initiateTask?.value ?? nil
            if let id {
                captureConversationId = id
                await store.setConversationId(local.id, id)   // remember the server id locally
                flushPendingSegments(conversationId: id)
            } else if isRecording {
                statusMessage = "Couldn't reach the server."
            }
        }

        // Voice Memos-style: rename the recording to where it was made, once both
        // the place and the conversation resolve. Optional — silent if declined.
        Task { [api] in
            guard let place = await locationNamer.currentPlaceName(),
                  let id = await initiateTask?.value ?? nil else { return }
            try? await api.updateConversation(id: id, fields: ["participant_name": place])
            if isRecording { recordingName = place }   // reflect the auto location name live
            await store.setName(local.id, place)
            await loadConversations()
        }
    }

    func stopAndUpload() async {
        guard isRecording else { return }
        isRecording = false
        isPaused = false
        showRecordingScreen = false
        meterTimer?.invalidate()
        meterTimer = nil
        endLiveActivity()
        stopLiveTranscriptPolling()
        recorder.stop()                       // emits the final segment synchronously
        statusMessage = "Finishing…"
        saveState = .saving

        let localId = activeLocalId
        let duration = recordingElapsed
        if let localId { await store.finish(localId, duration: duration) }

        var resolved = captureConversationId
        if resolved == nil { resolved = await initiateTask?.value ?? nil }
        guard let conversationId = resolved else {
            // Couldn't create the conversation — but the audio is safe on disk.
            // Surface it as a pending upload instead of losing it.
            statusMessage = nil
            cleanupCapture()
            activeLocalId = nil
            await refreshPendingRecordings()
            flashSaveState(.failed)
            return
        }
        captureConversationId = conversationId
        if let localId { await store.setConversationId(localId, conversationId) }
        flushPendingSegments(conversationId: conversationId)

        // Drain uploads + finalize under a background-task assertion so they get
        // ~30s to complete even if the app is backgrounded mid-upload.
        var finished = false
        await withUploadBackgroundTask("stop-upload") { [self] in
            for task in chunkUploads { await task.value }   // wait for every chunk
            finished = await finishConversationSucceeds(conversationId)
        }

        // Drop the local copy ONLY when the chunks are all uploaded AND the
        // conversation was finalized; otherwise keep it pending so push retries.
        if let localId {
            let onDisk = Set(await store.segmentFiles(localId).map(\.index))
            let uploaded = Set(await store.get(localId)?.uploadedSegments ?? [])
            if finished, !onDisk.isEmpty, uploaded.isSuperset(of: onDisk) {
                await store.remove(localId)
            }
        }
        activeLocalId = nil

        cleanupCapture()
        statusMessage = "Processing audio…"
        await loadConversations()
        await refreshPendingRecordings()
        statusMessage = nil
        flashSaveState(finished ? .saved : .failed)
    }

    private func finishConversationSucceeds(_ conversationId: String) async -> Bool {
        do { try await uploader.finishConversation(conversationId: conversationId); return true }
        catch { return false }
    }

    /// Run upload-critical work with a background-task assertion so iOS grants
    /// extra time to finish even if the app is backgrounded mid-upload.
    private func withUploadBackgroundTask(_ name: String, _ work: () async -> Void) async {
        let app = UIApplication.shared
        var taskId: UIBackgroundTaskIdentifier = .invalid
        taskId = app.beginBackgroundTask(withName: name) {
            if taskId != .invalid { app.endBackgroundTask(taskId); taskId = .invalid }
        }
        await work()
        if taskId != .invalid { app.endBackgroundTask(taskId); taskId = .invalid }
    }

    /// Throw the in-progress recording away — no upload. Stops capture, cancels
    /// in-flight chunk uploads, deletes local segments, and removes the server-side
    /// conversation if one was already created.
    func discardRecording() {
        guard isRecording else { return }
        isRecording = false
        isPaused = false
        showRecordingScreen = false
        recorder.onSegment = nil          // don't upload the final segment stop() emits
        endLiveActivity()
        stopLiveTranscriptPolling()
        recorder.stop()
        for task in chunkUploads { task.cancel() }
        let knownId = captureConversationId
        let pendingInitiate = initiateTask
        let localId = activeLocalId
        activeLocalId = nil
        Task { [api, store] in
            if let localId { await store.remove(localId) }   // delete the durable local copy
            var id = knownId
            if id == nil { id = await pendingInitiate?.value ?? nil }
            if let id { try? await api.deleteConversation(id: id) }
        }
        cleanupCapture()
        saveState = .idle
        statusMessage = nil
    }

    // MARK: - Pending (local-first) recordings

    /// Recordings still on disk that aren't the one being recorded right now —
    /// i.e. failed/interrupted uploads or ones recovered after an app kill.
    func refreshPendingRecordings() async {
        let active = activeLocalId
        pendingRecordings = (await store.all()).filter { $0.id != active }
    }

    /// Push a pending recording to dembrane: create the conversation if needed,
    /// upload every on-disk segment not yet sent, finish, then drop the local copy.
    func uploadPending(_ recording: LocalRecording) async {
        guard !uploadingRecordingIds.contains(recording.id) else { return }
        uploadingRecordingIds.insert(recording.id)
        defer { uploadingRecordingIds.remove(recording.id) }

        var conversationId = recording.conversationId
        if conversationId == nil {
            conversationId = try? await uploader.startConversation(
                projectId: recording.projectId, displayName: recording.displayName)
            if let cid = conversationId { await store.setConversationId(recording.id, cid) }
        }
        guard let conversationId else {
            statusMessage = "Couldn't reach the server — try again."
            return
        }
        var success = false
        await withUploadBackgroundTask("push-pending") { [self] in
            let uploaded = Set(recording.uploadedSegments)
            for seg in await store.segmentFiles(recording.id) where !uploaded.contains(seg.index) {
                let timestamp = recording.createdAt.addingTimeInterval(Double(seg.index) * chunkSeconds)
                do {
                    try await uploader.uploadChunk(
                        conversationId: conversationId, fileURL: seg.url, timestamp: timestamp)
                    await store.markUploaded(recording.id, index: seg.index)
                } catch { return }   // still pending; leave the local copy
            }
            // Only drop the local copy once the conversation is finalized too.
            success = await finishConversationSucceeds(conversationId)
        }
        if success { await store.remove(recording.id) }
        await loadConversations()
        await refreshPendingRecordings()
    }

    func deletePending(_ recording: LocalRecording) async {
        await store.remove(recording.id)
        await refreshPendingRecordings()
    }

    /// Compose a pending recording's segments into one m4a for export/share.
    func exportPending(_ recording: LocalRecording) async -> URL? {
        let segs = await store.segmentFiles(recording.id)
        guard !segs.isEmpty else { return nil }
        if segs.count == 1 { return segs[0].url }
        let composition = AVMutableComposition()
        guard let track = composition.addMutableTrack(
            withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { return nil }
        var cursor = CMTime.zero
        for seg in segs {
            let asset = AVURLAsset(url: seg.url)
            guard let source = try? await asset.loadTracks(withMediaType: .audio).first,
                  let duration = try? await asset.load(.duration) else { continue }
            try? track.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: source, at: cursor)
            cursor = cursor + duration
        }
        let safeName = recording.displayName.replacingOccurrences(of: "/", with: "-")
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("\(safeName).m4a")
        try? FileManager.default.removeItem(at: out)
        guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetAppleM4A) else { return nil }
        do {
            try await export.export(to: out, as: .m4a)
            return out
        } catch { return nil }
    }

    /// Poll the in-progress conversation's chunks so the Now-Recording screen can
    /// show a live (lagging) transcript.
    private func startLiveTranscriptPolling() {
        transcriptPollTask?.cancel()
        liveTranscript = ""
        transcriptPollTask = Task { [weak self] in
            while !Task.isCancelled {
                if let self, let id = self.captureConversationId,
                   let chunks = try? await self.api.conversationChunks(id: id) {
                    self.liveTranscript = chunks
                        .sorted { ($0.timestamp ?? .distantPast) < ($1.timestamp ?? .distantPast) }
                        .compactMap { $0.transcript?.trimmingCharacters(in: .whitespacesAndNewlines) }
                        .filter { !$0.isEmpty }
                        .joined(separator: " ")
                }
                try? await Task.sleep(for: .seconds(8))
            }
        }
    }

    private func stopLiveTranscriptPolling() {
        transcriptPollTask?.cancel()
        transcriptPollTask = nil
    }

    /// Show a save outcome, then auto-dismiss the banner.
    private func flashSaveState(_ state: SaveState) {
        saveState = state
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2.5))
            if saveState == state { saveState = .idle }
        }
    }

    private func handleSegment(_ segment: AudioRecorder.Segment) {
        // The segment is already written to the durable local folder — record it.
        if let lid = activeLocalId {
            Task { await store.noteSegment(lid, index: segment.index) }
        }
        if let id = captureConversationId {
            uploadSegment(segment, conversationId: id)
        } else {
            pendingSegments.append(segment)        // buffer until the conversation exists
        }
    }

    private func flushPendingSegments(conversationId: String) {
        let buffered = pendingSegments
        pendingSegments = []
        for segment in buffered { uploadSegment(segment, conversationId: conversationId) }
    }

    private func uploadSegment(_ segment: AudioRecorder.Segment, conversationId: String) {
        guard let start = captureStart else { return }
        let timestamp = start.addingTimeInterval(Double(segment.index) * chunkSeconds)
        let lid = activeLocalId
        let task = Task { [uploader, store] in
            do {
                try await uploader.uploadChunk(
                    conversationId: conversationId, fileURL: segment.url, timestamp: timestamp)
                // Keep the durable file (cleaned up only on full upload); mark it sent.
                if let lid { await store.markUploaded(lid, index: segment.index) }
            } catch {
                NSLog("dembrane-go chunk \(segment.index) upload failed: \(error)")
            }
        }
        chunkUploads.append(task)
    }

    /// Recent conversations for the Home tab.
    var recentConversations: [Conversation] { Array(conversations.prefix(3)) }

    /// Upload an audio file transferred from the Apple Watch.
    func uploadWatchFile(_ url: URL) async {
        guard let projectId = selectedProject?.id else { return }
        statusMessage = "Importing watch recording…"
        _ = try? await uploader.upload(
            projectId: projectId, fileURL: url,
            displayName: Date().formatted(date: .abbreviated, time: .shortened),
            contentType: "audio/m4a", source: "GO_WATCH", recordedAt: Date())
        try? FileManager.default.removeItem(at: url)
        await loadConversations()
        statusMessage = nil
    }

    // Mic / input selection (meaningful while the session is active).
    func availableInputs() -> [AudioRecorder.Input] { recorder.availableInputs() }
    var currentInputUID: String? { recorder.currentInputUID }
    var currentInputName: String? {
        recorder.availableInputs().first { $0.id == recorder.currentInputUID }?.name
    }
    func selectInput(uid: String) { recorder.selectInput(uid: uid) }

    func pauseRecording() {
        guard isRecording, !isPaused else { return }
        recorder.pause()
        isPaused = true
        lastPauseAt = Date()
    }

    func resumeRecording() {
        guard isRecording, isPaused else { return }
        if let pausedAt = lastPauseAt { pausedTotal += Date().timeIntervalSince(pausedAt) }
        lastPauseAt = nil
        recorder.resume()
        isPaused = false
    }

    private func startMeterTimer() {
        meterTimer?.invalidate()
        // .common mode so the waveform + clock keep updating while the user
        // scrolls or interacts elsewhere (default-mode timers pause during scroll).
        let timer = Timer(timeInterval: 1.0 / 12.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tickMeter() }
        }
        RunLoop.main.add(timer, forMode: .common)
        meterTimer = timer
    }

    /// ~12 Hz: update the elapsed clock (date-based, so it survives backgrounding)
    /// and push a level sample into the rolling waveform buffer.
    private func tickMeter() {
        guard isRecording else { return }
        recordingElapsed = currentElapsed()
        guard !isPaused else { return }
        audioLevels.append(recorder.currentLevel())
        if audioLevels.count > Self.waveformBarCount {
            audioLevels.removeFirst(audioLevels.count - Self.waveformBarCount)
        }
    }

    private func currentElapsed() -> TimeInterval {
        guard let start = recordingStartedAt else { return 0 }
        var elapsed = Date().timeIntervalSince(start) - pausedTotal
        if isPaused, let pausedAt = lastPauseAt { elapsed -= Date().timeIntervalSince(pausedAt) }
        return max(0, elapsed)
    }

    private func cleanupCapture() {
        captureConversationId = nil
        captureStart = nil
        recordingStartedAt = nil
        meterTimer?.invalidate()
        meterTimer = nil
        isPaused = false
        audioLevels = []
        recordingName = nil
        pendingSegments = []
        chunkUploads = []
        initiateTask = nil
        recorder.onSegment = nil
        liveTranscript = ""
    }

    private func startLiveActivity() {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let state = RecordingActivityAttributes.ContentState(
            startedAt: Date(), projectName: selectedProject?.name ?? defaultProjectName)
        liveActivity = try? Activity.request(
            attributes: RecordingActivityAttributes(),
            content: .init(state: state, staleDate: nil))
    }

    private func endLiveActivity() {
        let ending = liveActivity
        liveActivity = nil
        Task {
            await ending?.end(nil, dismissalPolicy: .immediate)
            for activity in Activity<RecordingActivityAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }

    /// If a request failed because the session is truly dead (401 even after the
    /// refresh-retry), sign out so the user re-authenticates instead of staring at
    /// a silently-empty app. Returns true if it signed out. Transient/offline
    /// errors are ignored (we keep showing cached data).
    @discardableResult
    private func signOutIfUnauthorized(_ error: Error) async -> Bool {
        guard case APIError.badStatus(401) = error else { return false }
        await signOut()
        return true
    }

    func loadData() async {
        // Paint cached conversations first so Home recents are instant — don't make
        // them wait behind the me/workspaces/projects network waterfall below.
        await loadCachedConversations()
        do {
            me = try await api.me()
        } catch {
            // Validate the session on launch: a dead session → show login.
            if await signOutIfUnauthorized(error) { return }
        }
        workspaces = (try? await api.workspaces()) ?? []
        await loadAllProjects()

        // Ensure the default capture project ("Go Recordings") exists in the default workspace.
        if let dws = workspaces.first(where: { $0.isDefault }) ?? workspaces.first,
           !allProjects.contains(where: { $0.workspace.id == dws.id && $0.project.name.localizedCaseInsensitiveCompare(defaultProjectName) == .orderedSame }),
           let created = try? await api.createProject(workspaceId: dws.id, name: defaultProjectName) {
            allProjects.append(WorkspaceProject(project: created, workspace: dws))
        }

        // Active project: keep a valid current/restored selection; else stored → default → first.
        // If the project list failed to load, keep whatever was restored (don't blank it out —
        // that was the "no project to save to" bug on a cold/flaky launch).
        if !allProjects.isEmpty {
            let restored = restoredProject()
            if let current = selectedProject, allProjects.contains(where: { $0.project.id == current.id }) {
                // keep the current selection
            } else {
                selectedProject = allProjects.first(where: { $0.project.id == restored?.id })?.project
                    ?? allProjects.first(where: { $0.project.name.localizedCaseInsensitiveCompare(defaultProjectName) == .orderedSame })?.project
                    ?? allProjects.first?.project
            }
            persistSelectedProject()
        }

        // First run: let the user pick which workspace their "Go Recordings"
        // project lives in (we still auto-picked a default so capture isn't blocked).
        if !UserDefaults.standard.bool(forKey: Self.didOnboardKey), !workspaces.isEmpty {
            showOnboarding = true
        }

        await loadConversations()
        await refreshWorkspaceUsage()
    }

    /// Finish onboarding: find-or-create "Go Recordings" in the chosen workspace
    /// and make it the active project.
    func completeOnboarding(workspace: Workspace) async {
        if let existing = allProjects.first(where: {
            $0.workspace.id == workspace.id
                && $0.project.name.localizedCaseInsensitiveCompare(defaultProjectName) == .orderedSame
        }) {
            selectProject(existing)
        } else if let created = try? await api.createProject(workspaceId: workspace.id, name: defaultProjectName) {
            let wp = WorkspaceProject(project: created, workspace: workspace)
            allProjects.append(wp)
            selectProject(wp)
        }
        UserDefaults.standard.set(true, forKey: Self.didOnboardKey)
        showOnboarding = false
    }

    /// Flat list of projects across every workspace the user can see.
    func loadAllProjects() async {
        if allProjects.isEmpty,
           let cached = await DiskCache.shared.load([WorkspaceProject].self, key: "allProjects") {
            allProjects = cached
        }
        var result: [WorkspaceProject] = []
        for workspace in workspaces {
            let projects = (try? await api.projects(workspaceId: workspace.id)) ?? []
            result += projects.map { WorkspaceProject(project: $0, workspace: workspace) }
        }
        if !result.isEmpty {
            allProjects = result
            await DiskCache.shared.save(result, key: "allProjects")
            AppGroup.writeProjects(result)   // let the Share Extension pick a destination
        }
    }

    /// Participant-portal URL a QR encodes: {portalBase}/{locale}/{projectId}/start.
    func portalURL(for project: Project) -> URL {
        let map = ["en": "en-US", "nl": "nl-NL", "de": "de-DE", "fr": "fr-FR",
                   "es": "es-ES", "it": "it-IT", "uk": "uk-UA", "cs": "cs-CZ"]
        let raw = project.language ?? "en"
        let locale = raw.contains("-") ? raw : (map[raw] ?? "en-US")
        return environment.portalBaseURL.appending(path: "\(locale)/\(project.id)/start")
    }

    /// Current portal defaults (title / description / key terms) for editing.
    func portalSettings(projectId: String) async -> PortalSettings? {
        try? await api.portalSettings(projectId: projectId)
    }

    @discardableResult
    func updatePortalSettings(projectId: String, title: String,
                              description: String, context: String) async -> Bool {
        do {
            try await api.updatePortalSettings(projectId: projectId, fields: [
                "default_conversation_title": title,
                "default_conversation_description": description,
                "context": context,
            ])
            return true
        } catch { return false }
    }

    /// Fetch free-tier upload gating for the active project's workspace.
    func refreshWorkspaceUsage() async {
        guard let projectId = selectedProject?.id,
              let workspaceId = allProjects.first(where: { $0.project.id == projectId })?.workspace.id
        else { return }
        workspaceUsage = try? await api.workspaceUsage(workspaceId: workspaceId)
    }

    /// Cache-only paint (no network) for instant launch — recents render before
    /// the network waterfall in `loadData` even begins.
    func loadCachedConversations() async {
        guard conversations.isEmpty, let projectId = selectedProject?.id else { return }
        if let cached = await DiskCache.shared.load([Conversation].self, key: "conversations.\(projectId)") {
            conversations = cached
            didLoadConversationsOnce = true
        }
    }

    func loadConversations() async {
        guard let projectId = selectedProject?.id else { conversations = []; return }
        let cacheKey = "conversations.\(projectId)"
        // Show the last fetch instantly, then reconcile with the network.
        if let cached = await DiskCache.shared.load([Conversation].self, key: cacheKey) {
            conversations = cached
            didLoadConversationsOnce = true
        }
        conversationsLoading = conversations.isEmpty
        conversationsError = false
        defer { conversationsLoading = false; didLoadConversationsOnce = true }
        do {
            let fresh = try await api.conversations(projectId: projectId)
            conversations = fresh
            await DiskCache.shared.save(fresh, key: cacheKey)
        } catch {
            // A dead session shows an empty/stale list silently — detect + sign out.
            if await signOutIfUnauthorized(error) { return }
            conversationsError = conversations.isEmpty
        }
    }

    /// Create a project in the default workspace, then select it.
    @discardableResult
    func createProject(name: String) async -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let workspace = workspaces.first(where: { $0.isDefault }) ?? workspaces.first
        else { return false }
        do {
            let project = try await api.createProject(workspaceId: workspace.id, name: trimmed)
            let wp = WorkspaceProject(project: project, workspace: workspace)
            allProjects.append(wp)
            selectProject(wp)
            return true
        } catch {
            statusMessage = "Couldn't create the project."
            return false
        }
    }

    func selectProject(_ workspaceProject: WorkspaceProject) {
        guard workspaceProject.project.id != selectedProject?.id else { return }
        selectedProject = workspaceProject.project
        persistSelectedProject()
        conversations = []   // drop the previous project's rows; cache/network repopulate
        Task { await loadConversations(); await refreshWorkspaceUsage() }
    }

    /// Persist the whole selected project so it restores instantly on next launch
    /// (even before — or without — a successful network fetch).
    private func persistSelectedProject() {
        guard let project = selectedProject, let data = try? JSONEncoder().encode(project) else { return }
        UserDefaults.standard.set(data, forKey: Self.selectedProjectKey)
        AppGroup.write(projectId: project.id, projectName: project.name, environment: environment)   // for the Share Extension
    }

    private func restoredProject() -> Project? {
        guard let data = UserDefaults.standard.data(forKey: Self.selectedProjectKey) else { return nil }
        return try? JSONDecoder().decode(Project.self, from: data)
    }

    /// Full conversation detail (summary + merged transcript), cached for an
    /// optimistic open next time.
    func conversationDetail(id: String) async throws -> Conversation {
        let detail = try await api.conversation(id: id)
        await DiskCache.shared.save(detail, key: "conv.\(id)")
        return detail
    }

    /// Per-chunk transcripts — shown while `merged_transcript` is still null
    /// (it only fills in after the full merge finishes). Cached for instant reopen.
    func conversationChunks(id: String) async throws -> [ConversationChunk] {
        let chunks = try await api.conversationChunks(id: id)
        await DiskCache.shared.save(chunks, key: "chunks.\(id)")
        return chunks
    }

    /// Cached detail / chunks for an instant open (then reconciled with network).
    func cachedDetail(id: String) async -> Conversation? {
        await DiskCache.shared.load(Conversation.self, key: "conv.\(id)")
    }
    func cachedChunks(id: String) async -> [ConversationChunk]? {
        await DiskCache.shared.load([ConversationChunk].self, key: "chunks.\(id)")
    }

    /// Signed playback URL for a conversation's merged audio (nil if unavailable).
    func conversationAudioURL(id: String) async -> URL? {
        try? await api.conversationAudioURL(id: id)
    }

    // Conversation actions (mirror the web's summary/title/retranscribe controls).
    func summarizeConversation(_ id: String) async throws {
        try await api.summarizeConversation(id: id)
        await loadConversations()
    }
    func generateConversationTitle(_ id: String) async throws {
        try await api.generateConversationTitle(id: id)
        await loadConversations()
    }
    func retranscribeConversation(_ id: String) async throws {
        try await api.retranscribeConversation(id: id)
        await loadConversations()
    }

    /// Edit a conversation's title / participant name / summary, then refresh
    /// the list so the row reflects the change.
    func updateConversation(id: String, title: String, participantName: String, summary: String) async throws {
        try await api.updateConversation(id: id, fields: [
            "title": title,
            "participant_name": participantName,
            "summary": summary,
        ])
        await loadConversations()
    }

    /// Move a conversation to another project. It leaves the current project's
    /// list, so drop it locally on success.
    func moveConversation(_ id: String, to projectId: String) async {
        let snapshot = conversations
        conversations.removeAll { $0.id == id }
        do {
            try await api.moveConversation(id: id, targetProjectId: projectId)
        } catch {
            conversations = snapshot
            statusMessage = "Couldn't move — try again."
        }
    }

    /// Dashboard portal-editor URL for the selected project (Settings link).
    var portalEditorURL: URL? {
        guard let project = selectedProject,
              let wp = allProjects.first(where: { $0.project.id == project.id })
        else { return nil }
        return environment.dashboardBaseURL
            .appending(path: "w/\(wp.workspace.id)/projects/\(project.id)/portal-editor")
    }

    /// Soft-delete (recoverable for a grace period server-side). Removes the row
    /// optimistically and restores it if the request fails.
    func deleteConversation(_ conversation: Conversation) async {
        let snapshot = conversations
        conversations.removeAll { $0.id == conversation.id }
        do {
            try await api.deleteConversation(id: conversation.id)
        } catch {
            conversations = snapshot
            statusMessage = "Couldn't delete — try again."
        }
    }

    // MARK: - Tags

    /// Lazy per-row tag cache (in-memory) so list rows can show tag chips without
    /// blocking — each row loads once on appear, then it's instant.
    var conversationTagsCache: [String: [ProjectTag]] = [:]

    func loadTagsForRow(_ id: String) async {
        guard conversationTagsCache[id] == nil else { return }
        let tags = (try? await api.conversationTags(conversationId: id)) ?? []
        conversationTagsCache[id] = tags
    }

    /// Invalidate a conversation's cached row tags (after an edit).
    func invalidateRowTags(_ id: String) { conversationTagsCache[id] = nil }

    /// Add the given tags to every conversation (bulk-tag from multi-select),
    /// preserving each conversation's existing tags.
    func addTags(_ tagIds: Set<String>, to conversationIds: Set<String>) async {
        guard !tagIds.isEmpty else { return }
        for id in conversationIds {
            let existing = Set(((try? await api.conversationTags(conversationId: id)) ?? []).map(\.id))
            let merged = existing.union(tagIds)
            if merged != existing {
                try? await api.replaceConversationTags(conversationId: id, tagIds: Array(merged))
            }
            conversationTagsCache[id] = nil   // refresh on next view
        }
    }

    func projectTags(projectId: String) async throws -> [ProjectTag] {
        try await api.projectTags(projectId: projectId)
    }
    func conversationTags(_ id: String) async throws -> [ProjectTag] {
        try await api.conversationTags(conversationId: id)
    }
    func createTag(projectId: String, text: String) async throws -> ProjectTag {
        try await api.createTag(projectId: projectId, text: text)
    }
    func setConversationTags(_ id: String, tagIds: [String]) async throws {
        try await api.replaceConversationTags(conversationId: id, tagIds: tagIds)
        conversationTagsCache[id] = nil   // row chips refresh on next view
    }

    /// Start an Ask scoped to a conversation (swipe action) and jump to Ask.
    func askAbout(_ conversation: Conversation) {
        pendingAskConversationId = conversation.id
        selectedTab = .ask
    }

    /// Ask scoped to several selected conversations (multi-select).
    func askAboutMany(_ ids: Set<String>) {
        setAskContext(ids)
        pendingAskConversationId = nil
        selectedTab = .ask
    }

    /// Delete several conversations (multi-select). Optimistic; restores on error.
    func deleteConversations(_ ids: Set<String>) async {
        guard !ids.isEmpty else { return }
        let snapshot = conversations
        conversations.removeAll { ids.contains($0.id) }
        for id in ids {
            do {
                try await api.deleteConversation(id: id)
            } catch {
                conversations = snapshot
                statusMessage = "Couldn't delete — try again."
                return
            }
        }
    }

    // MARK: - Ask (chat)

    /// The conversation currently being recorded (if any), so Ask can scope to it.
    var currentRecordingConversationId: String? { isRecording ? captureConversationId : nil }

    /// Consume a pending swipe-to-Ask: scope the thread to that conversation.
    /// Also auto-adds the in-progress recording, if any (per product ask).
    func startAskForPending() {
        if let id = pendingAskConversationId {
            pendingAskConversationId = nil
            askConversationIds = [id]
            resetAskThread()
        } else if let live = currentRecordingConversationId, !askConversationIds.contains(live) {
            askConversationIds.insert(live)
            resetAskThread()
        }
    }

    /// Toggle a conversation in/out of the Ask context. If a chat is already
    /// underway, newly-added context is attached to that SAME chat (no reset);
    /// only a fresh thread resets.
    func toggleAskConversation(_ id: String) {
        let adding = !askConversationIds.contains(id)
        if adding { askConversationIds.insert(id) } else { askConversationIds.remove(id) }
        if let chatId = currentChatId {
            if adding {
                Task { try? await chatService.addContext(chatId: chatId, conversationId: id) }
            }
        } else {
            resetAskThread()
        }
    }

    /// Replace the Ask context in one shot (from the context picker's Done).
    /// Within an active chat, attach the newly-added conversations to it instead
    /// of starting over — so you can grow context mid-conversation.
    func setAskContext(_ ids: Set<String>) {
        guard ids != askConversationIds else { return }
        let added = ids.subtracting(askConversationIds)
        askConversationIds = ids
        if let chatId = currentChatId {
            Task { for id in added { try? await chatService.addContext(chatId: chatId, conversationId: id) } }
        } else {
            resetAskThread()
        }
    }

    func resetAskThread() {
        currentChatId = nil
        askMessages = []
        askError = nil
    }

    /// Quick templates: dembrane built-ins + the workspace's shared/personal ones.
    func chatTemplates() async -> [PromptTemplate] {
        let workspaceId = selectedProject.flatMap { project in
            allProjects.first { $0.project.id == project.id }?.workspace.id
        }
        let remote = (try? await chatService.listTemplates(workspaceId: workspaceId)) ?? []
        return PromptTemplate.builtins + remote
    }

    /// Select all loaded conversations as Ask context.
    func selectAllAskConversations() {
        setAskContext(Set(conversations.map(\.id)))
    }

    /// Past chats for the selected project (history).
    func recentChats() async -> [Chat] {
        guard let projectId = selectedProject?.id else { return [] }
        return (try? await chatService.listChats(projectId: projectId)) ?? []
    }

    /// Resume a past chat: load its messages into the thread.
    func openChat(_ chat: Chat) async {
        let messages = (try? await chatService.chatMessages(chatId: chat.id)) ?? []
        askMessages = messages.compactMap { message in
            guard let text = message.text?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !text.isEmpty else { return nil }
            return AskMessage(role: message.messageFrom == "user" ? .user : .assistant, text: text)
        }
        currentChatId = chat.id
        askError = nil
    }

    /// Send a message: lazily create the chat (+ add the selected conversations
    /// as context), then stream the assistant reply.
    func sendAsk(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !askStreaming, let projectId = selectedProject?.id else { return }
        askError = nil
        askMessages.append(AskMessage(role: .user, text: trimmed))
        // Show the assistant typing bubble immediately — before the chat-creation
        // and add-context round-trips — so feedback is instant on send. AskBubble
        // renders a spinner while this message's text is empty.
        askMessages.append(AskMessage(role: .assistant, text: ""))
        let idx = askMessages.count - 1
        askStreaming = true
        defer { askStreaming = false }

        do {
            let chatId: String
            if let existing = currentChatId {
                chatId = existing
            } else {
                let specific = askConversationIds
                let chat = try await chatService.createChat(
                    projectId: projectId, autoSelect: specific.isEmpty)
                currentChatId = chat.id
                chatId = chat.id
                for cid in specific {
                    try? await chatService.addContext(chatId: chatId, conversationId: cid)
                }
            }

            // Wire = the thread up to (not including) the empty assistant placeholder.
            let wire = askMessages[..<idx].map {
                ChatWireMessage(role: $0.role == .user ? "user" : "assistant", content: $0.text)
            }

            for try await event in await chatService.streamMessage(chatId: chatId, messages: wire) {
                switch event {
                case .text(let delta): askMessages[idx].text += delta
                case .references(let refs): askMessages[idx].references = refs
                case .error(let message): askError = message
                case .other: break
                }
            }
        } catch {
            NSLog("dembrane-go Ask failed: \(error)")
            askError = "Couldn't get a response. Please try again."
        }
        // Drop a stuck empty bubble if the reply never produced any text.
        if idx < askMessages.count, askMessages[idx].role == .assistant, askMessages[idx].text.isEmpty {
            askMessages.remove(at: idx)
        }
    }
}

/// A single Ask message for display.
struct AskMessage: Identifiable, Equatable {
    enum Role { case user, assistant }
    let id = UUID()
    let role: Role
    var text: String
    var references: [ConversationReference] = []
}
