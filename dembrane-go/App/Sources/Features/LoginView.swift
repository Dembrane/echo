import SwiftUI
import DembraneCore

struct LoginView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var email = ""
    @State private var password = ""
    @State private var otp = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Spacer()

            // Logo stays centered; everything else is left-aligned.
            Image("DembraneLogo")
                .resizable().scaledToFit().frame(width: 200)
                .frame(maxWidth: .infinity)
                .accessibilityLabel("dembrane")

            VStack(alignment: .leading, spacing: 6) {
                Text("Welcome!")
                    .font(.largeTitle.weight(.semibold)).foregroundStyle(.primary)
                Text("Please log in to continue.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            VStack(spacing: 12) {
                TextField("Email", text: $email)
                    .textContentType(.emailAddress).keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("Password", text: $password).textContentType(.password)
                if model.needsOTP {
                    TextField("2FA code", text: $otp)
                        .textContentType(.oneTimeCode).keyboardType(.numberPad)
                }
            }
            .textFieldStyle(.roundedBorder)

            if let error = model.loginError {
                Text(error).font(.callout)
                    .foregroundStyle(BrandColor.cottonCandy)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Button {
                Task { await model.signIn(email: email, password: password,
                                          otp: model.needsOTP ? otp : nil) }
            } label: {
                if model.isSigningIn {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    Text(model.needsOTP ? "Verify & sign in" : "Login")
                        .font(.headline).frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent).controlSize(.large).tint(BrandColor.royalBlue)
            .disabled(email.isEmpty || password.isEmpty || model.isSigningIn
                      || (model.needsOTP && otp.count < 6))

            VStack(alignment: .leading, spacing: 10) {
                Button("Forgot your password?") {
                    openURL(model.environment.dashboardBaseURL.appendingPathComponent("forgot-password"))
                }
                Button("Create an account") {
                    openURL(model.environment.dashboardBaseURL.appendingPathComponent("register"))
                }
            }
            .font(.callout).tint(BrandColor.royalBlue)

            Spacer()

            HStack(spacing: 8) {
                legalLink("Terms", "terms")
                Text("·").foregroundStyle(.secondary)
                legalLink("Privacy", "privacy")
            }
            .font(.caption)
            .frame(maxWidth: .infinity)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func legalLink(_ title: String, _ path: String) -> some View {
        Button(title) {
            openURL(URL(string: "https://www.dembrane.com/legal/\(path)")!)
        }
        .tint(.secondary)
    }
}

#Preview {
    LoginView().environment(AppModel.makeMock())
}
