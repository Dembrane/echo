import Foundation

/// The password policy the server enforces on registration (dembrane/platform/packages/
/// account/src/password.ts). Checked here first, so a person sees what is missing
/// instead of a refused account.
public enum PasswordRules {
    public static let summary = "At least 8 characters, with an uppercase and a lowercase letter, a number and a symbol."

    /// What the password still lacks, in the order of `summary`; empty when it passes.
    public static func unmet(_ password: String) -> [String] {
        var out: [String] = []
        if password.count < 8 { out.append("8 characters") }
        if password.range(of: "[A-Z]", options: .regularExpression) == nil { out.append("an uppercase letter") }
        if password.range(of: "[a-z]", options: .regularExpression) == nil { out.append("a lowercase letter") }
        if password.range(of: "[0-9]", options: .regularExpression) == nil { out.append("a number") }
        if password.range(of: "[^A-Za-z0-9]", options: .regularExpression) == nil { out.append("a symbol") }
        return out
    }
}
