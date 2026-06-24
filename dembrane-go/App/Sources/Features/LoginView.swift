import SwiftUI
import DembraneCore

struct LoginView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var email = ""
    @State private var password = ""
    @State private var showRegister = false

    var body: some View {
        VStack(spacing: 18) {
            Spacer()

            Image("DembraneLogo")
                .resizable().scaledToFit().frame(width: 200)
                .accessibilityLabel("dembrane")

            VStack(spacing: 6) {
                Text("Welcome!")
                    .font(.largeTitle).foregroundStyle(BrandColor.graphite)
                Text("Please log in to continue.")
                    .font(.callout).foregroundStyle(BrandColor.graphite.opacity(0.7))
            }

            VStack(spacing: 12) {
                TextField("Email", text: $email)
                    .textContentType(.emailAddress).keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("Password", text: $password).textContentType(.password)
            }
            .textFieldStyle(.roundedBorder)

            if let error = model.loginError {
                Text(error).font(.callout)
                    .foregroundStyle(BrandColor.cottonCandy).multilineTextAlignment(.center)
            }

            Button {
                Task { await model.signIn(email: email, password: password) }
            } label: {
                if model.isSigningIn { ProgressView().frame(maxWidth: .infinity) }
                else { Text("Login").frame(maxWidth: .infinity) }
            }
            .buttonStyle(.borderedProminent).tint(BrandColor.royalBlue)
            .disabled(email.isEmpty || password.isEmpty || model.isSigningIn)

            Button("Forgot your password?") {
                openURL(model.environment.dashboardBaseURL.appendingPathComponent("forgot-password"))
            }
            .font(.callout).tint(BrandColor.royalBlue)

            Button("Create an account") { showRegister = true }
                .font(.callout).tint(BrandColor.royalBlue)

            Spacer()

            HStack(spacing: 8) {
                legalLink("Terms", "terms")
                Text("·").foregroundStyle(.secondary)
                legalLink("Privacy", "privacy")
                Text("·").foregroundStyle(.secondary)
                legalLink("DPA", "DPA")
            }
            .font(.caption)

            Menu {
                ForEach(AppEnvironment.allCases, id: \.self) { env in
                    Button { model.setEnvironment(env) } label: {
                        if env == model.environment {
                            Label(env.displayName, systemImage: "checkmark")
                        } else {
                            Text(env.displayName)
                        }
                    }
                }
            } label: {
                Text(model.environment.displayName)
                    .font(.caption2).foregroundStyle(BrandColor.graphite.opacity(0.4))
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(BrandColor.parchment)
        .sheet(isPresented: $showRegister) { RegisterView() }
    }

    private func legalLink(_ title: String, _ path: String) -> some View {
        Button(title) {
            openURL(URL(string: "https://www.dembrane.com/legal/\(path)")!)
        }
        .tint(BrandColor.graphite.opacity(0.6))
    }
}

#Preview {
    LoginView().environment(AppModel.makeMock())
}
