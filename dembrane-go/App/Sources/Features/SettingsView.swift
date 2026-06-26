import SwiftUI
import DembraneCore

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var showProjectPicker = false

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section("Account") {
                    LabeledContent("Signed in as", value: model.me?.email ?? "Not set")
                    Button("Sign out", role: .destructive) {
                        Task { await model.signOut() }
                    }
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
                    LabeledContent("Version", value: "0.1.0")
                    Link("Source code", destination: URL(string: "https://github.com/dembrane")!)
                }
            }
            .navigationTitle("Settings")
            .sheet(isPresented: $showProjectPicker) {
                ProjectPicker { model.selectProject($0) }
            }
        }
    }
}

#Preview {
    SettingsView().environment(AppModel.makeMock())
}
