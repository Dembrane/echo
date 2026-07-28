import SwiftUI
import DembraneCore

/// First-run: choose the workspace where the "Go Recordings" capture project
/// lives. We find-or-create it there.
struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @State private var working = false

    var body: some View {
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
