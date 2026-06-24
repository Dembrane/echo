import SwiftUI
import DembraneCore

struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        VStack(spacing: 20) {
            Spacer()

            VStack(spacing: 8) {
                Image(systemName: "waveform.circle.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(BrandColor.royalBlue)
                Text("dembrane go")
                    .font(.largeTitle)
                    .foregroundStyle(BrandColor.graphite)
                Text("Record any conversation. Make sense of it.")
                    .font(.callout)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(BrandColor.graphite.opacity(0.7))
            }

            VStack(spacing: 12) {
                TextField("Email", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Password", text: $password)
                    .textContentType(.password)
            }
            .textFieldStyle(.roundedBorder)

            if let error = model.loginError {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(BrandColor.cottonCandy)
                    .multilineTextAlignment(.center)
            }

            Button {
                Task { await model.signIn(email: email, password: password) }
            } label: {
                if model.isSigningIn {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    Text("Sign in").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(BrandColor.royalBlue)
            .disabled(email.isEmpty || password.isEmpty || model.isSigningIn)

            Text("Sign in with Apple — coming soon")
                .font(.footnote)
                .foregroundStyle(BrandColor.graphite.opacity(0.5))

            Spacer()

            Text("source available · ISO 27001 · no training on your data · based in the Netherlands")
                .font(.caption2)
                .multilineTextAlignment(.center)
                .foregroundStyle(BrandColor.graphite.opacity(0.5))
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(BrandColor.parchment)
    }
}

#Preview {
    LoginView().environment(AppModel.makeMock())
}
