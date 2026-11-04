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
            SignedInElsewhereView(devices: elsewhere.devices)
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
                        safariURL = model.environment.dashboardBaseURL.appendingPathComponent("request-password-reset").appendingUTMSource()
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

/// Shown when a sign-in met the account signed in on two other devices, its
/// limit. One decision: sign out a chosen device and continue, or go back. The
/// words are the dashboard's for the same moment.
private struct SignedInElsewhereView: View {
    @Environment(AppModel.self) private var model
    let devices: [OtherDevice]
    @State private var choice: OtherDevice.ID?

    /// The choice only while that device is still in the list the server sent.
    private var selected: OtherDevice.ID? {
        devices.contains { $0.id == choice } ? choice : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Spacer()
            Text("Choose a device to sign out")
                .font(.title.weight(.semibold)).foregroundStyle(.primary)
            Text("Your account can be signed in on up to two devices. Choose one to sign out so you can continue here.")
                .font(.callout).foregroundStyle(.secondary)
            Text("Sharing this login with a colleague? An admin of your organisation can invite them, so each of you has a login of your own.")
                .font(.caption).foregroundStyle(.secondary)

            VStack(spacing: 10) {
                ForEach(devices) { device in
                    DeviceChoiceRow(device: device, isSelected: device.id == selected) {
                        choice = device.id
                    }
                }
            }
            .disabled(model.isSigningIn)

            if let error = model.loginError {
                Text(error).font(.callout)
                    .foregroundStyle(BrandColor.cottonCandy)
            }

            VStack(alignment: .leading, spacing: 8) {
                Button {
                    guard let selected else { return }
                    Task { await model.signOutDeviceAndContinue(selected) }
                } label: {
                    if model.isSigningIn {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Text("Sign out selected device and continue").font(.headline)
                            .multilineTextAlignment(.center).frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.glassProminent).controlSize(.large).tint(BrandColor.royalBlue)
                .disabled(model.isSigningIn || selected == nil)
                Text("The other device will stay signed in.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Button("Back to log in") { Task { await model.cancelHeldSignIn() } }
                .font(.callout).tint(BrandColor.royalBlue)
                .disabled(model.isSigningIn)
            Spacer()
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

/// One signed-in device to choose: its name, when it was last used, and a check
/// mark once chosen.
private struct DeviceChoiceRow: View {
    let device: OtherDevice
    let isSelected: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            HStack(spacing: 14) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isSelected ? BrandColor.royalBlue : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(device.name).font(.body.weight(.medium)).foregroundStyle(.primary)
                    if let lastActive = device.lastActiveAt {
                        Text("Last active \(lastActive.formatted(date: .abbreviated, time: .shortened))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .background(Color(.secondarySystemBackground),
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(isSelected ? AnyShapeStyle(BrandColor.royalBlue) : AnyShapeStyle(.quaternary)))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

#Preview {
    LoginView().environment(AppModel.makeMock())
}
