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

/// Liquid Glass shell: Home · Conversations · Ask · Search, with a persistent
/// Record accessory above the tab bar (the prominent capture action) that
/// expands into the Now-Recording screen.
struct MainTabView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.selectedTab) {
            Tab("Home", systemImage: "house", value: AppModel.AppTab.home) {
                HomeView()
            }
            Tab("Conversations", systemImage: "waveform", value: AppModel.AppTab.conversations) {
                ConversationsView()
            }
            Tab("Ask", systemImage: "sparkles", value: AppModel.AppTab.ask) {
                AskView()
            }
            Tab(value: AppModel.AppTab.search, role: .search) {
                SearchView()
            }
        }
        .tint(BrandColor.royalBlue)
        .tabBarMinimizeBehavior(.onScrollDown)
        .tabViewBottomAccessory { RecordBar() }
        .sheet(isPresented: $model.showRecordingScreen) { NowRecordingView() }
    }
}

#Preview("Signed in") {
    MainTabView().environment(AppModel.makeMock())
}
