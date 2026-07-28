import SwiftUI
import DembraneCore

struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var email = ""
    @State private var password = ""
    @State private var otp = ""
    @State private var showRegister = false
    @State private var safariURL: URL?
    @FocusState private var focused: Field?
    private enum Field { case email, password, otp }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Spacer()

            // Fades away when a field is focused (keyboard up) instead of shrinking.
            // Offset left to cancel the logo art's internal padding so it lines up
            // with where "Welcome" starts.
            if focused == nil {
                Image("DembraneLogo")
                    .resizable().scaledToFit().frame(width: 180)
                    .offset(x: -12)
                    .transition(.opacity)
                    .accessibilityLabel("dembrane")
            }

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
                    .focused($focused, equals: .email)
                    .loginFieldStyle()
                SecureField("Password", text: $password).textContentType(.password)
                    .focused($focused, equals: .password)
                    .loginFieldStyle()
                if model.needsOTP {
                    TextField("2FA code", text: $otp)
                        .textContentType(.oneTimeCode).keyboardType(.numberPad)
                        .focused($focused, equals: .otp)
                        .loginFieldStyle()
                }
            }
            .animation(.easeInOut(duration: 0.25), value: focused)

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
            .buttonStyle(.glassProminent).controlSize(.large).tint(BrandColor.royalBlue)
            .disabled(email.isEmpty || password.isEmpty || model.isSigningIn
                      || (model.needsOTP && otp.count < 6))

            VStack(alignment: .leading, spacing: 10) {
                Button("Forgot your password?") {
                    safariURL = model.environment.dashboardBaseURL.appendingPathComponent("forgot-password").appendingUTMSource()
                }
                Button("Create an account") { showRegister = true }
            }
            .font(.callout).tint(BrandColor.royalBlue)

            Spacer()

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    legalLink("Terms", "terms")
                    Text("·").foregroundStyle(.secondary)
                    legalLink("Privacy", "privacy")
                }
                Text("© dembrane BV \(String(Calendar.current.component(.year, from: Date())))")
                    .foregroundStyle(.tertiary)
            }
            .font(.caption)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .sheet(isPresented: $showRegister) { RegisterView() }
        .safariSheet(url: $safariURL)
    }

    private func legalLink(_ title: String, _ path: String) -> some View {
        Button(title) {
            safariURL = URL(string: "https://www.dembrane.com/legal/\(path)")!.appendingUTMSource()
        }
        .tint(.secondary)
    }
}

private extension View {
    /// Bigger, rounded login text fields.
    func loginFieldStyle() -> some View {
        font(.title3)
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(Color(.secondarySystemBackground),
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.quaternary))
    }
}

#Preview {
    LoginView().environment(AppModel.makeMock())
}
