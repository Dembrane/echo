import SwiftUI
import DembraneCore

struct SettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section("Account") {
                    LabeledContent("Signed in as", value: model.me?.email ?? "—")
                    Button("Sign out", role: .destructive) {
                        // M1: clear session
                    }
                }

                Section("Recording") {
                    LabeledContent("Default project", value: model.defaultProjectName)
                    Picker("Environment", selection: $model.environment) {
                        ForEach(AppEnvironment.allCases, id: \.self) { env in
                            Text(env.displayName).tag(env)
                        }
                    }
                }

                Section {
                    Toggle("Train language models on my data", isOn: $model.trainingOptIn)
                } header: {
                    Text("Privacy & data")
                } footer: {
                    Text("Off by default. We don't train language models on your recordings unless you opt in. Source available · ISO 27001 · based in the Netherlands.")
                }

                Section("About") {
                    LabeledContent("Version", value: "0.1.0")
                    Link("Source code", destination: URL(string: "https://github.com/dembrane")!)
                }
            }
            .navigationTitle("Settings")
        }
    }
}

#Preview {
    SettingsView().environment(AppModel.makeMock())
}
