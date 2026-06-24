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
    enum AppTab: Hashable, Sendable { case record, conversations, ask, settings }

    // UI state
    var phase: Phase = .loading
    var selectedTab: AppTab = .record
    var environment: AppEnvironment
    var trainingOptIn = false
    let defaultProjectName = "go"
    var isRecording = false
    var loginError: String?
    var isSigningIn = false
    var statusMessage: String?
    var isRegistering = false
    var registerError: String?
    var registrationSentTo: String?

    // Loaded data
    var me: Me?
    var workspaces: [Workspace] = []
    var allProjects: [WorkspaceProject] = []
    var selectedProject: Project?
    var conversations: [Conversation] = []

    private static let selectedProjectKey = "dembrane.go.selectedProjectId"
    private static let environmentKey = "dembrane.go.environment"

    private let sessionManager: SessionManager
    private var auth: AuthService
    private var api: DembraneAPIClientProtocol
    private let uploader: ParticipantUploadClient
    private let recorder = AudioRecorder()
    private var liveActivity: Activity<RecordingActivityAttributes>?

    init(environment: AppEnvironment,
         sessionManager: SessionManager,
         auth: AuthService,
         api: DembraneAPIClientProtocol) {
        self.environment = environment
        self.sessionManager = sessionManager
        self.auth = auth
        self.api = api
        self.uploader = ParticipantUploadClient(env: environment)
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
        case "conversations": selectedTab = .conversations
        case "ask": selectedTab = .ask
        case "settings": selectedTab = .settings
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
        do {
            try recorder.start()
            isRecording = true
            statusMessage = nil
            startLiveActivity()
        } catch {
            statusMessage = "Couldn't start recording."
        }
    }

    func stopAndUpload() async {
        isRecording = false
        endLiveActivity()
        guard let result = recorder.stop() else { return }
        guard let projectId = selectedProject?.id else {
            statusMessage = "No project to save to yet."
            return
        }
        statusMessage = "Uploading…"
        do {
            _ = try await uploader.upload(
                projectId: projectId, fileURL: result.url,
                displayName: me?.displayName ?? "dembrane Go",
                contentType: "audio/m4a", recordedAt: Date())
            statusMessage = "Processing audio…"
            await loadConversations()
            statusMessage = nil
        } catch {
            statusMessage = "Upload failed — try again."
        }
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

        // Ensure the "go" capture project exists in the default workspace.
        if let dws = workspaces.first(where: { $0.isDefault }) ?? workspaces.first,
           !allProjects.contains(where: { $0.workspace.id == dws.id && $0.project.name.lowercased() == defaultProjectName }),
           let created = try? await api.createProject(workspaceId: dws.id, name: defaultProjectName) {
            allProjects.append(WorkspaceProject(project: created, workspace: dws))
        }

        // Active project: last choice → "go" → first available.
        let storedId = UserDefaults.standard.string(forKey: Self.selectedProjectKey)
        selectedProject = allProjects.first(where: { $0.project.id == storedId })?.project
            ?? allProjects.first(where: { $0.project.name.lowercased() == defaultProjectName })?.project
            ?? allProjects.first?.project

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
        conversations = (try? await api.conversations(projectId: projectId)) ?? []
    }

    func selectProject(_ workspaceProject: WorkspaceProject) {
        selectedProject = workspaceProject.project
        UserDefaults.standard.set(workspaceProject.project.id, forKey: Self.selectedProjectKey)
        Task { await loadConversations() }
    }
}
