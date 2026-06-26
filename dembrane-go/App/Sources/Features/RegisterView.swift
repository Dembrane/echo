import SwiftUI
import DembraneCore

struct RegisterView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var step = 0
    @State private var firstName = ""
    @State private var lastName = ""
    @State private var email = ""
    @State private var password = ""
    @State private var confirm = ""
    @State private var acceptedTerms = false

    var body: some View {
        NavigationStack {
            Group {
                if let sentTo = model.registrationSentTo {
                    verifyStep(email: sentTo)
                } else if step == 0 {
                    detailsStep
                } else {
                    passwordStep
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .navigationTitle("Create an account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { model.registrationSentTo = nil; dismiss() }
                }
            }
        }
    }

    private var detailsStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Three quick steps and you're in.").foregroundStyle(.secondary)
            Group {
                TextField("First name", text: $firstName).textContentType(.givenName)
                TextField("Last name (optional)", text: $lastName).textContentType(.familyName)
                TextField("Email", text: $email)
                    .textContentType(.emailAddress).keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
            }
            .textFieldStyle(.roundedBorder)

            Toggle(isOn: $acceptedTerms) {
                Button("I have read and accept the terms") {
                    openURL(URL(string: "https://www.dembrane.com/legal/terms")!)
                }
                .font(.callout).tint(BrandColor.royalBlue)
            }

            if let error = model.registerError {
                Text(error).font(.callout).foregroundStyle(BrandColor.cottonCandy)
            }

            Button("Continue") { step = 1 }
                .buttonStyle(.glassProminent).tint(BrandColor.royalBlue)
                .frame(maxWidth: .infinity)
                .disabled(firstName.isEmpty || !email.contains("@") || !acceptedTerms)
            Spacer()
        }
    }

    private var passwordStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Group {
                SecureField("Password", text: $password).textContentType(.newPassword)
                SecureField("Confirm password", text: $confirm).textContentType(.newPassword)
            }
            .textFieldStyle(.roundedBorder)

            Text("At least 8 characters.").font(.caption).foregroundStyle(.secondary)

            if let error = model.registerError {
                Text(error).font(.callout).foregroundStyle(BrandColor.cottonCandy)
            }

            HStack {
                Button("Back") { step = 0 }.tint(.secondary)
                Spacer()
                Button {
                    Task { await model.register(firstName: firstName, lastName: lastName, email: email, password: password) }
                } label: {
                    if model.isRegistering { ProgressView() } else { Text("Create account") }
                }
                .buttonStyle(.glassProminent).tint(BrandColor.royalBlue)
                .disabled(password.count < 8 || password != confirm || model.isRegistering)
            }
            Spacer()
        }
    }

    private func verifyStep(email: String) -> some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "envelope.badge").font(.system(size: 48)).foregroundStyle(BrandColor.royalBlue)
            Text("Check your email").font(.title).foregroundStyle(.primary)
            Text("We've sent a verification link to \(email). Open the email and click the link to continue.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
            Text("Didn't get it? Check your spam or junk folder. The email comes from dembrane.com.")
                .font(.caption).multilineTextAlignment(.center).foregroundStyle(.secondary)
            Button("Done") { model.registrationSentTo = nil; dismiss() }
                .buttonStyle(.glassProminent).tint(BrandColor.royalBlue)
            Spacer()
        }
    }
}

#Preview {
    RegisterView().environment(AppModel.makeMock())
}
