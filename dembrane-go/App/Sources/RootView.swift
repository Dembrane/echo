import SwiftUI
import DembraneCore

/// Routes between loading, sign-in, and the signed-in tab shell.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.phase {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .signedOut:
            LoginView()
        case .signedIn:
            MainTabView()
        }
    }
}

/// Tab bar: Home · Record · Conversations · Ask. Tapping Record starts capture
/// (no idle accessory); while recording, the Record tab is hidden and a
/// Now-Playing-style accessory bar appears -> Home · Conversations · Ask.
struct MainTabView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        let tabs = TabView(selection: $model.selectedTab) {
            Tab("Home", systemImage: "house", value: AppModel.AppTab.home) {
                HomeView()
            }
            if !model.isRecording {
                Tab("Record", systemImage: "record.circle", value: AppModel.AppTab.record) {
                    Color.clear   // action tab — selection is intercepted to start recording
                }
            }
            Tab("Conversations", systemImage: "waveform", value: AppModel.AppTab.conversations) {
                ConversationsView()
            }
            Tab("Ask", systemImage: "sparkles", value: AppModel.AppTab.ask) {
                AskView()
            }
        }
        .tint(BrandColor.royalBlue)
        .onChange(of: model.selectedTab) { _, newValue in
            if newValue == .record {
                model.selectedTab = .home
                model.showRecordingScreen = true   // open the armed Record sheet (don't auto-start)
            }
        }

        Group {
            if model.isRecording {
                tabs.tabViewBottomAccessory { RecordBar() }
            } else {
                tabs
            }
        }
        .overlay(alignment: .bottom) {
            if model.saveState != .idle {
                SaveBanner(state: model.saveState, project: model.selectedProject?.name)
                    .padding(.bottom, 64)   // float just above the tab bar
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(duration: 0.35), value: model.saveState)
        .sensoryFeedback(trigger: model.saveState) { _, new in
            switch new { case .saved: .success; case .failed: .error; default: nil }
        }
        .sheet(isPresented: $model.showRecordingScreen) { NowRecordingView() }
        .sheet(isPresented: $model.showOnboarding) { OnboardingView() }
    }
}

/// Transient "Saving… / Saved" confirmation that floats above the tab bar after
/// a recording stops — closes the loop so capture never feels like it vanished.
private struct SaveBanner: View {
    let state: AppModel.SaveState
    let project: String?

    var body: some View {
        HStack(spacing: 8) {
            switch state {
            case .saving:
                ProgressView().controlSize(.small)
                Text("Saving…")
            case .saved:
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text(project.map { "Saved to \($0)" } ?? "Saved")
            case .failed:
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text("Couldn't save. Check your connection.")
            case .idle:
                EmptyView()
            }
        }
        .font(.subheadline.weight(.medium))
        .lineLimit(1)
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(.quaternary))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
    }
}

#Preview("Signed in") {
    MainTabView().environment(AppModel.makeMock())
}
