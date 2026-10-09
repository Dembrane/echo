import SwiftUI
import DembraneCore

struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var email = ""
    @State private var password = ""
    @State private var otp = ""
    /// Sign-in with an emailed six-digit code, for people without a password.
    @State private var codeMode = false
    @State private var codeSent = false
    @State private var isSendingCode = false
    @State private var emailedCode = ""
    @State private var showRegister = false
    @State private var safariURL: URL?
    @FocusState private var focused: Field?
    private enum Field { case email, password, otp, emailedCode }

    var body: some View {
        if let elsewhere = model.signedInElsewhere {
            SignedInElsewhereView(since: elsewhere.since)
        } else {
            form
        }
    }

    private var form: some View {
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
                    .disabled(codeMode && codeSent)
                if codeMode {
                    if codeSent {
                        Text("We sent a six-digit code to \(trimmedEmail).")
                            .font(.callout).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        TextField("Six-digit code", text: $emailedCode)
                            .textContentType(.oneTimeCode).keyboardType(.numberPad)
                            .focused($focused, equals: .emailedCode)
                            .loginFieldStyle()
                    }
                } else {
                    SecureField("Password", text: $password).textContentType(.password)
                        .focused($focused, equals: .password)
                        .loginFieldStyle()
                    if model.needsOTP {
                        TextField("Authenticator code", text: $otp)
                            .textContentType(.oneTimeCode).keyboardType(.numberPad)
                            .focused($focused, equals: .otp)
                            .loginFieldStyle()
                    }
                }
            }
            .animation(.easeInOut(duration: 0.25), value: focused)

            if let error = model.loginError {
                Text(error).font(.callout)
                    .foregroundStyle(BrandColor.cottonCandy)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Button {
                Task { await submit() }
            } label: {
                if model.isSigningIn || isSendingCode {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    Text(primaryTitle).font(.headline).frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.glassProminent).controlSize(.large).tint(BrandColor.royalBlue)
            .disabled(!canSubmit)

            VStack(alignment: .leading, spacing: 10) {
                if codeMode {
                    if codeSent {
                        Button("Send a new code") { Task { await sendCode() } }
                            .disabled(isSendingCode)
                    }
                    Button("Use my password instead") { setCodeMode(false) }
                } else {
                    Button("Forgot your password?") {
                        safariURL = model.environment.dashboardBaseURL.appendingPathComponent("forgot-password").appendingUTMSource()
                    }
                    Button("Email me a sign-in code instead") { setCodeMode(true) }
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

    private var trimmedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var primaryTitle: String {
        if codeMode { return codeSent ? "Login" : "Email me a code" }
        return model.needsOTP ? "Verify & sign in" : "Login"
    }

    private var canSubmit: Bool {
        if model.isSigningIn || isSendingCode { return false }
        if codeMode { return codeSent ? emailedCode.count >= 6 : trimmedEmail.contains("@") }
        return !email.isEmpty && !password.isEmpty && !(model.needsOTP && otp.count < 6)
    }

    private func submit() async {
        if codeMode {
            if codeSent {
                await model.signIn(email: trimmedEmail, code: emailedCode)
                emailedCode = ""
            } else {
                await sendCode()
            }
        } else {
            await model.signIn(email: email, password: password, otp: model.needsOTP ? otp : nil)
        }
    }

    private func sendCode() async {
        isSendingCode = true
        defer { isSendingCode = false }
        if await model.sendSignInCode(email: trimmedEmail) {
            codeSent = true
            emailedCode = ""
            focused = .emailedCode
        }
    }

    private func setCodeMode(_ on: Bool) {
        codeMode = on
        codeSent = false
        emailedCode = ""
        model.loginError = nil
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

/// Shown when a sign-in met the account signed in on another device. The
/// account allows one device at a time, so going ahead signs the other one out.
private struct SignedInElsewhereView: View {
    @Environment(AppModel.self) private var model
    let since: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Spacer()
            Text("This account is logged in somewhere else")
                .font(.title.weight(.semibold)).foregroundStyle(.primary)
            Text(explanation)
                .font(.callout).foregroundStyle(.secondary)

            if let error = model.loginError {
                Text(error).font(.callout)
                    .foregroundStyle(BrandColor.cottonCandy)
            }

            VStack(alignment: .leading, spacing: 8) {
                Button {
                    Task { await model.logInAnyway() }
                } label: {
                    if model.isSigningIn {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Text("Log in anyway").font(.headline).frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.glassProminent).controlSize(.large).tint(BrandColor.royalBlue)
                .disabled(model.isSigningIn)
                Text("Logging in here logs the other device out.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Button("Back to log in") { Task { await model.cancelLogInAnyway() } }
                .font(.callout).tint(BrandColor.royalBlue)
                .disabled(model.isSigningIn)
            Spacer()
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private var explanation: String {
        let rule = "For security, an account can be logged in on one device at a time."
        guard let since else { return "It is logged in on another device. \(rule)" }
        let when = since.formatted(date: .abbreviated, time: .shortened)
        return "It has been logged in on another device since \(when). \(rule)"
    }
}

#Preview {
    LoginView().environment(AppModel.makeMock())
}
