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
        .sheet(isPresented: $model.showRecordingScreen) { NowRecordingView() }
        .sheet(isPresented: $model.showOnboarding) { OnboardingView() }
    }
}

#Preview("Signed in") {
    MainTabView().environment(AppModel.makeMock())
}
