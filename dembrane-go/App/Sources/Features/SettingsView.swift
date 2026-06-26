import SwiftUI
import DembraneCore

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var showProjectPicker = false
    @State private var confirmDelete = false

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section("Account") {
                    LabeledContent("Signed in as", value: model.me?.email ?? "Not set")
                    Button("Sign out", role: .destructive) {
                        Task { await model.signOut() }
                    }
                    Button("Delete account", role: .destructive) { confirmDelete = true }
                }

                Section("Project") {
                    Button {
                        showProjectPicker = true
                    } label: {
                        HStack {
                            Text("Default project")
                            Spacer()
                            Text(model.selectedProject?.name ?? "Not set").foregroundStyle(.secondary)
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                    if let url = model.portalEditorURL {
                        Link(destination: url) {
                            Label("Open project editor", systemImage: "slider.horizontal.3")
                        }
                    }
                }

                Section("About") {
                    LabeledContent("Version", value: appVersion)
                    Link("Source code", destination: URL(string: "https://github.com/dembrane")!)
                }
            }
            .navigationTitle("Settings")
            .sheet(isPresented: $showProjectPicker) {
                ProjectPicker { model.selectProject($0) }
            }
            .confirmationDialog("Delete your account?",
                                isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Continue in browser", role: .destructive) {
                    openURL(model.environment.dashboardBaseURL)
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Account deletion happens on the web. We'll open the dembrane dashboard — sign in there to delete your account and all its data.")
            }
        }
    }

    private var appVersion: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
        return b.isEmpty ? v : "\(v) (\(b))"
    }
}

#Preview {
    SettingsView().environment(AppModel.makeMock())
}
