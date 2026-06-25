import SwiftUI
import DembraneCore

@main
struct DembraneGoApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(BrandColor.royalBlue)   // brand accent app-wide (controls, sheets, alerts)
                .task { await model.start() }
        }
    }
}
