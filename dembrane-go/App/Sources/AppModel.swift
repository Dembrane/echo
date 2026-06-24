import Foundation
import AVFoundation
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

    // Loaded data
    var me: Me?
    var workspaces: [Workspace] = []
    var defaultWorkspace: Workspace?
    var defaultProject: Project?
    var conversations: [Conversation] = []

    private let sessionManager: SessionManager
    private let auth: AuthService
    private let api: DembraneAPIClientProtocol
    private let uploader: ParticipantUploadClient
    private let recorder = AudioRecorder()

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
    convenience init(environment: AppEnvironment = .default) {
        let sm = SessionManager(store: makeSessionStore())
        let auth = AuthService(env: environment, sessionManager: sm)
        let api = LiveAPIClient(
            env: environment,
            tokenProvider: { await sm.accessToken() },
            onUnauthorized: { (try? await auth.refresh()) ?? false })
        self.init(environment: environment, sessionManager: sm, auth: auth, api: api)
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

    func signOut() async {
        await auth.logout()
        me = nil
        workspaces = []
        conversations = []
        defaultWorkspace = nil
        defaultProject = nil
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
        } catch {
            statusMessage = "Couldn't start recording."
        }
    }

    func stopAndUpload() async {
        isRecording = false
        guard let result = recorder.stop() else { return }
        guard let projectId = defaultProject?.id else {
            statusMessage = "No project to save to yet."
            return
        }
        statusMessage = "Uploading…"
        do {
            _ = try await uploader.upload(
                projectId: projectId, fileURL: result.url,
                displayName: me?.displayName ?? "dembrane go",
                contentType: "audio/m4a", recordedAt: Date())
            statusMessage = "Processing audio…"
            await loadData()
            statusMessage = nil
        } catch {
            statusMessage = "Upload failed — try again."
        }
    }

    func loadData() async {
        me = try? await api.me()
        workspaces = (try? await api.workspaces()) ?? []
        let workspace = workspaces.first(where: { $0.isDefault }) ?? workspaces.first
        defaultWorkspace = workspace
        guard let workspace else { return }

        // Ensure the "go" capture project exists in this workspace (first run).
        var projects = (try? await api.projects(workspaceId: workspace.id)) ?? []
        if !projects.contains(where: { $0.name.lowercased() == defaultProjectName }),
           let created = try? await api.createProject(workspaceId: workspace.id, name: defaultProjectName) {
            projects.append(created)
        }
        defaultProject = projects.first { $0.name.lowercased() == defaultProjectName } ?? projects.first

        if let project = defaultProject {
            conversations = (try? await api.conversations(projectId: project.id)) ?? []
        }
    }
}
