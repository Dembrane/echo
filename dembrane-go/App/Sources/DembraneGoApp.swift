import SwiftUI
import DembraneCore

@main
struct DembraneGoApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(BrandColor.royalBlue)   // brand accent app-wide (controls, sheets, alerts)
                .task { await model.start() }
                .onChange(of: scenePhase) { _, phase in
                    guard phase == .active else { return }
                    model.handleLaunchIntents()   // Action Button / Siri "Start Recording"
                    model.reconcileOnForeground()  // flush + refresh if mid-recording
                }
        }
    }
}
