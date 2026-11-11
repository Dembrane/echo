import Foundation

/// Which dembrane backend the app talks to. Default is production.
public enum AppEnvironment: String, CaseIterable, Sendable, Codable {
    case production
    case staging
    case echoNext
    case local

    public static let `default`: AppEnvironment = .production

    /// API base, including the trailing `/api` segment. Sign-in lives under it too.
    public var apiBaseURL: URL {
        switch self {
        case .production: return URL(string: "https://api.dembrane.com/api")!
        case .staging:    return URL(string: "https://api.staging.dembrane.com/api")!
        case .echoNext:   return URL(string: "https://api.echo-next.dembrane.com/api")!
        case .local:      return URL(string: "http://localhost:8080/api")!
        }
    }

    /// Dashboard web app (used for forgot-password + email-verification links).
    public var dashboardBaseURL: URL {
        switch self {
        case .production: return URL(string: "https://dashboard.dembrane.com")!
        case .staging:    return URL(string: "https://dashboard.staging.dembrane.com")!
        case .echoNext:   return URL(string: "https://dashboard.echo-next.dembrane.com")!
        case .local:      return URL(string: "http://localhost:5173")!
        }
    }

    /// Participant portal (used to open a project's portal editor).
    public var portalBaseURL: URL {
        switch self {
        case .production: return URL(string: "https://portal.dembrane.com")!
        case .staging:    return URL(string: "https://portal.staging.dembrane.com")!
        case .echoNext:   return URL(string: "https://portal.echo-next.dembrane.com")!
        case .local:      return URL(string: "http://localhost:5174")!
        }
    }

    public var displayName: String {
        switch self {
        case .production: return "Production"
        case .staging:    return "Staging"
        case .echoNext:   return "echo-next"
        case .local:      return "Local"
        }
    }
}
