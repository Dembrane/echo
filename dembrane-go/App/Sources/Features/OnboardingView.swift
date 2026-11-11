import SwiftUI
import DembraneCore

/// First-run: choose the workspace where the "Go Recordings" capture project
/// lives. We find-or-create it there. A new account without a workspace sets one
/// up first.
struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @State private var working = false
    @State private var organisationName = ""

    var body: some View {
        if model.needsWorkspace {
            setUpWorkspace
        } else {
            chooseWorkspace
        }
    }

    private var setUpWorkspace: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Image("DembraneLogo")
                    .resizable().scaledToFit().frame(width: 180)
                    .padding(.top, 24)
                Text("Set up your workspace").font(.title2.weight(.semibold))
                Text("Your recordings are kept in a workspace that belongs to your organisation. Name it to start recording.")
                    .font(.callout).foregroundStyle(.secondary)
                TextField("Organisation name", text: $organisationName)
                    .textContentType(.organizationName)
                    .textFieldStyle(.roundedBorder)
                    .disabled(working)
                if let error = model.onboardingError {
                    Text(error).font(.callout).foregroundStyle(BrandColor.cottonCandy)
                }
                Button {
                    working = true
                    Task {
                        await model.createFirstWorkspace(
                            organisationName: organisationName.trimmingCharacters(in: .whitespacesAndNewlines))
                        working = false
                    }
                } label: {
                    if working {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Text("Continue").font(.headline).frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.glassProminent).controlSize(.large).tint(BrandColor.royalBlue)
                .disabled(working || organisationName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Spacer()
            }
            .padding(.horizontal, 28)
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(true)
            .onAppear {
                // The dashboard's default, so both name a new organisation the same way.
                if organisationName.isEmpty, let name = model.me?.displayName, !name.isEmpty {
                    organisationName = "\(name)'s Organisation"
                }
            }
        }
    }

    private var chooseWorkspace: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Image("DembraneLogo")
                    .resizable().scaledToFit().frame(width: 180)
                    .padding(.top, 24)
                VStack(spacing: 6) {
                    Text("Choose a workspace").font(.title2.weight(.semibold))
                    Text("dembrane Go will set up your “Go Recordings” project here so you can capture in a tap.")
                        .font(.callout).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 24)

                List(model.workspaces, id: \.id) { workspace in
                    Button {
                        working = true
                        Task { await model.completeOnboarding(workspace: workspace) }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(workspace.name).foregroundStyle(.primary)
                                if let org = workspace.orgName, !org.isEmpty {
                                    Text(org).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            if workspace.isDefault {
                                Text("Default").font(.caption2).foregroundStyle(.secondary)
                            }
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                    .disabled(working)
                }
                .listStyle(.insetGrouped)

                if working { ProgressView().padding(.bottom) }
            }
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(true)
        }
    }
}

#Preview {
    OnboardingView().environment(AppModel.makeMock())
}
