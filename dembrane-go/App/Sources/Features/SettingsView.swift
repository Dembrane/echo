import SwiftUI
import DembraneCore

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var showProjectPicker = false
    @State private var confirmDelete = false
    @State private var safariURL: URL?

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
                        Button {
                            safariURL = url
                        } label: {
                            Label("Open project editor", systemImage: "slider.horizontal.3")
                        }
                    }
                }

                Section("About") {
                    LabeledContent("Version", value: appVersion)
                    Button("Source code") {
                        safariURL = URL(string: "https://github.com/dembrane")!
                    }
                }

                // Separated from Sign out so it's hard to hit by mistake.
                Section {
                    Button {
                        confirmDelete = true
                    } label: {
                        if model.isDeletingAccount {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Text("Delete account").foregroundStyle(.red)
                        }
                    }
                    .disabled(model.isDeletingAccount)
                } footer: {
                    Text("Permanently deletes your account and all its data within 30 days. Your account stops working right away.")
                }
            }
            .navigationTitle("Settings")
            .sheet(isPresented: $showProjectPicker) {
                ProjectPicker { model.selectProject($0) }
            }
            .safariSheet(url: $safariURL)
            .confirmationDialog("Delete your account?",
                                isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete my account", role: .destructive) {
                    Task { await model.deleteAccount() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This can't be undone. Your account stops working immediately and your account and all its data are permanently deleted within 30 days.")
            }
            .alert("Couldn't delete account",
                   isPresented: Binding(get: { model.deleteAccountError != nil },
                                        set: { if !$0 { model.deleteAccountError = nil } })) {
                Button("OK") { model.deleteAccountError = nil }
            } message: {
                Text(model.deleteAccountError ?? "")
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
