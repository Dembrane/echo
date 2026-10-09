import Foundation

/// Sign-in and session URLs. They live on the API host under `/api/auth`, next
/// to every other route the app calls.
public extension DembraneEndpoints {
    private var auth: URL { env.apiBaseURL.appending(path: "auth") }

    func signInEmail() -> URL { auth.appending(path: "sign-in/email") }
    func verifyTOTP() -> URL { auth.appending(path: "two-factor/verify-totp") }
    func sendSignInCode() -> URL { auth.appending(path: "email-otp/send-verification-otp") }
    func signInEmailCode() -> URL { auth.appending(path: "sign-in/email-otp") }
    func otherSessions() -> URL { auth.appending(path: "other-sessions") }
    func replaceOtherSessions() -> URL { auth.appending(path: "other-sessions/replace") }
    func getSession() -> URL { auth.appending(path: "get-session") }
    func signOut() -> URL { auth.appending(path: "sign-out") }

    /// A profile picture or logo by its file id, read with the session token.
    func asset(id: String) -> URL { env.apiBaseURL.appending(path: "assets/\(id)") }
}
