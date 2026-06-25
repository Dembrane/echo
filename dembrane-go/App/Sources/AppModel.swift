import Foundation
import AVFoundation
import ActivityKit
import Observation
import DembraneCore

/// App-wide state. Real stack uses the Keychain session + live API client;
/// previews/tests use an in-memory session + mock API.
@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable { case loading, signedOut, signedIn }
    enum AppTab: Hashable, Sendable { case home, conversations, ask, search }

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
    var audioLevels: [Float] = []
    var showRecordingScreen = false
    var loginError: String?
    var isSigningIn = false
    var statusMessage: String?
    var isRegistering = false
    var registerError: String?
    var registrationSentTo: String?
    var pendingAskConversationId: String?
    var pendingAskQuery: String?

    // Loaded data
    var me: Me?
    var workspaces: [Workspace] = []
    var allProjects: [WorkspaceProject] = []
    var selectedProject: Project?
    var conversations: [Conversation] = []
    var conversationsLoading = false
    var conversationsError = false

    // Ask (chat) state
    var askConversationIds: Set<String> = []
    var askMessages: [AskMessage] = []
    var askStreaming = false
    var askError: String?
    private var currentChatId: String?

    private static let selectedProjectKey = "dembrane.go.selectedProject"   // full Project JSON
    private static let environmentKey = "dembrane.go.environment"

    private let sessionManager: SessionManager
    private var auth: AuthService
    private var api: DembraneAPIClientProtocol
    private var chatService: ChatService
    private let uploader: ParticipantUploadClient
    private let recorder = AudioRecorder()
    private var liveActivity: Activity<RecordingActivityAttributes>?

    // Chunked-capture state
    private var captureConversationId: String?
    private var captureStart: Date?
    private var pendingSegments: [AudioRecorder.Segment] = []
    private var chunkUploads: [Task<Void, Never>] = []
    private var initiateTask: Task<String?, Never>?
    private let chunkSeconds: TimeInterval = 30
    private var meterTimer: Timer?
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
            onUnauthorized: { (try? await auth.refresh()) ?? false })
        self.init(environment: env, sessionManager: sm, auth: auth, api: api)
    }

    /// Preview/test stack: in-memory session + (by default) mock API.
    static func makeMock(api: DembraneAPIClientProtocol = MockAPIClient()) -> AppModel {
        let sm = SessionManager(store: InMemorySessionStore())
        let auth = AuthService(env: .echoNext, sessionManager: sm)
        return AppModel(environment: .echoNext, sessionManager: sm, auth: auth, api: api)
    }

    func start() async {
        #if DEBUG
        // Dev-only: point the sim at a chosen backend (default is production).
        if let envName = ProcessInfo.processInfo.environment["DEMBRANE_DEV_ENV"],
           let devEnv = AppEnvironment(rawValue: envName) {
            setEnvironment(devEnv)
        }
        #endif
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

    func signIn(email: String, password: String) async {
        loginError = nil
        isSigningIn = true
        defer { isSigningIn = false }
        do {
            _ = try await auth.login(email: email, password: password)
            phase = .signedIn
            await loadData()
        } catch AuthError.invalidCredentials {
            loginError = "That email or password didn't work."
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
            onUnauthorized: { [newAuth] in (try? await newAuth.refresh()) ?? false })
        chatService = ChatService(env: env,
                                  tokenProvider: { [sessionManager] in await sessionManager.accessToken() })
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

        isPaused = false
        pausedTotal = 0
        lastPauseAt = nil
        audioLevels = []
        recordingElapsed = 0
        do {
            // Start capturing immediately — don't wait on the network.
            try recorder.start(segmentEvery: chunkSeconds)
            isRecording = true
            statusMessage = nil
            showRecordingScreen = true        // open the Now-Recording screen
            startMeterTimer()
            startLiveActivity()
        } catch {
            statusMessage = "Couldn't start recording."
            return
        }

        // Create the conversation in parallel; flush buffered segments once ready.
        // Name it like Voice Memos (interim: date/time — location naming is a follow-up),
        // never the user's name.
        let displayName = Date().formatted(date: .abbreviated, time: .shortened)
        initiateTask = Task { [uploader] in
            try? await uploader.startConversation(projectId: projectId, displayName: displayName)
        }
        Task {
            let id = await initiateTask?.value ?? nil
            if let id {
                captureConversationId = id
                flushPendingSegments(conversationId: id)
            } else if isRecording {
                statusMessage = "Couldn't reach the server."
            }
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
        recorder.stop()                       // emits the final segment synchronously
        statusMessage = "Finishing…"

        var resolved = captureConversationId
        if resolved == nil { resolved = await initiateTask?.value ?? nil }
        guard let conversationId = resolved else {
            statusMessage = "Upload failed — couldn't reach the server."
            cleanupCapture()
            return
        }
        captureConversationId = conversationId
        flushPendingSegments(conversationId: conversationId)

        for task in chunkUploads { await task.value }   // wait for every chunk
        try? await uploader.finishConversation(conversationId: conversationId)

        cleanupCapture()
        statusMessage = "Processing audio…"
        await loadConversations()
        statusMessage = nil
    }

    private func handleSegment(_ segment: AudioRecorder.Segment) {
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
        let task = Task { [uploader] in
            do {
                try await uploader.uploadChunk(
                    conversationId: conversationId, fileURL: segment.url, timestamp: timestamp)
                try? FileManager.default.removeItem(at: segment.url)
            } catch {
                NSLog("dembrane-go chunk \(segment.index) upload failed: \(error)")
            }
        }
        chunkUploads.append(task)
    }

    /// Recent conversations for the Home tab.
    var recentConversations: [Conversation] { Array(conversations.prefix(3)) }

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
        meterTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 12.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tickMeter() }
        }
    }

    /// ~12 Hz: update the elapsed clock (date-based, so it survives backgrounding)
    /// and push a level sample into the rolling waveform buffer.
    private func tickMeter() {
        guard isRecording else { return }
        recordingElapsed = currentElapsed()
        guard !isPaused else { return }
        audioLevels.append(recorder.currentLevel())
        if audioLevels.count > 64 { audioLevels.removeFirst(audioLevels.count - 64) }
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
        pendingSegments = []
        chunkUploads = []
        initiateTask = nil
        recorder.onSegment = nil
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

    func loadData() async {
        me = try? await api.me()
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

        await loadConversations()
    }

    /// Flat list of projects across every workspace the user can see.
    func loadAllProjects() async {
        var result: [WorkspaceProject] = []
        for workspace in workspaces {
            let projects = (try? await api.projects(workspaceId: workspace.id)) ?? []
            result += projects.map { WorkspaceProject(project: $0, workspace: workspace) }
        }
        allProjects = result
    }

    func loadConversations() async {
        guard let projectId = selectedProject?.id else { conversations = []; return }
        conversationsLoading = true
        conversationsError = false
        defer { conversationsLoading = false }
        do {
            conversations = try await api.conversations(projectId: projectId)
        } catch {
            conversationsError = true
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
        selectedProject = workspaceProject.project
        persistSelectedProject()
        Task { await loadConversations() }
    }

    /// Persist the whole selected project so it restores instantly on next launch
    /// (even before — or without — a successful network fetch).
    private func persistSelectedProject() {
        guard let project = selectedProject, let data = try? JSONEncoder().encode(project) else { return }
        UserDefaults.standard.set(data, forKey: Self.selectedProjectKey)
    }

    private func restoredProject() -> Project? {
        guard let data = UserDefaults.standard.data(forKey: Self.selectedProjectKey) else { return nil }
        return try? JSONDecoder().decode(Project.self, from: data)
    }

    /// Full conversation detail (summary + merged transcript).
    func conversationDetail(id: String) async throws -> Conversation {
        try await api.conversation(id: id)
    }

    /// Per-chunk transcripts — shown while `merged_transcript` is still null
    /// (it only fills in after the full merge finishes).
    func conversationChunks(id: String) async throws -> [ConversationChunk] {
        try await api.conversationChunks(id: id)
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
    }

    /// Start an Ask scoped to a conversation (swipe action) and jump to Ask.
    func askAbout(_ conversation: Conversation) {
        pendingAskConversationId = conversation.id
        selectedTab = .ask
    }

    // MARK: - Ask (chat)

    /// Consume a pending swipe-to-Ask: scope the thread to that conversation.
    func startAskForPending() {
        guard let id = pendingAskConversationId else { return }
        pendingAskConversationId = nil
        askConversationIds = [id]
        resetAskThread()
    }

    /// Toggle a conversation in/out of the Ask context. Changing context starts
    /// a fresh thread (the server scopes context at chat creation).
    func toggleAskConversation(_ id: String) {
        if askConversationIds.contains(id) {
            askConversationIds.remove(id)
        } else {
            askConversationIds.insert(id)
        }
        resetAskThread()
    }

    /// Replace the Ask context in one shot (from the context picker's Done).
    /// Only resets the thread when the selection actually changed.
    func setAskContext(_ ids: Set<String>) {
        guard ids != askConversationIds else { return }
        askConversationIds = ids
        resetAskThread()
    }

    func resetAskThread() {
        currentChatId = nil
        askMessages = []
        askError = nil
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

            let wire = askMessages.map {
                ChatWireMessage(role: $0.role == .user ? "user" : "assistant", content: $0.text)
            }
            askMessages.append(AskMessage(role: .assistant, text: ""))
            let idx = askMessages.count - 1

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
