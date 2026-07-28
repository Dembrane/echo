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
                    switch phase {
                    case .active:
                        model.handleLaunchIntents()   // Action Button / Siri "Start Recording"
                        model.reconcileOnForeground()  // resume rotation + flush + refresh
                    case .background:
                        model.handleBackgrounded()     // keep one continuous file, no rotation
                    default: break
                    }
                }
        }
    }
}
