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
                .background(BrandColor.parchment)
        case .signedOut:
            LoginView()
        case .signedIn:
            MainTabView()
        }
    }
}

/// The 4-tab Liquid Glass shell with a floating recording mini-bar while capturing.
struct MainTabView: View {
    @Environment(AppModel.self) private var model

    @ViewBuilder var body: some View {
        @Bindable var model = model
        let tabs = TabView(selection: $model.selectedTab) {
            Tab("Record", systemImage: "mic.fill", value: AppModel.AppTab.record) { RecordView() }
            Tab("Conversations", systemImage: "waveform", value: AppModel.AppTab.conversations) { ConversationsView() }
            Tab("Ask", systemImage: "sparkles", value: AppModel.AppTab.ask) { AskView() }
            Tab("Settings", systemImage: "gearshape", value: AppModel.AppTab.settings) { SettingsView() }
        }
        .tint(BrandColor.royalBlue)

        // Only show the bottom accessory while recording — no empty bar when idle.
        if model.isRecording {
            tabs.tabViewBottomAccessory { RecordingMiniBar() }
        } else {
            tabs
        }
    }
}

#Preview("Signed in") {
    MainTabView().environment(AppModel.makeMock())
}
