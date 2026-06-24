import Foundation

/// Which dembrane backend the app talks to. Default is echo-next.
public enum AppEnvironment: String, CaseIterable, Sendable, Codable {
    case echoNext
    case production
    case local

    public static let `default`: AppEnvironment = .echoNext

    /// FastAPI base, including the trailing `/api` segment.
    public var apiBaseURL: URL {
        switch self {
        case .production: return URL(string: "https://api.dembrane.com/api")!
        case .echoNext:   return URL(string: "https://api.echo-next.dembrane.com/api")!
        case .local:      return URL(string: "http://localhost:8000/api")!
        }
    }

    /// Directus base (auth lives here).
    public var directusBaseURL: URL {
        switch self {
        case .production: return URL(string: "https://directus.dembrane.com")!
        case .echoNext:   return URL(string: "https://directus.echo-next.dembrane.com")!
        case .local:      return URL(string: "http://localhost:8055")!
        }
    }

    /// Dashboard web app (used for forgot-password + email-verification links).
    public var dashboardBaseURL: URL {
        switch self {
        case .production: return URL(string: "https://dashboard.dembrane.com")!
        case .echoNext:   return URL(string: "https://dashboard.echo-next.dembrane.com")!
        case .local:      return URL(string: "http://localhost:5173")!
        }
    }

    /// Participant portal (used to open a project's portal editor).
    public var portalBaseURL: URL {
        switch self {
        case .production: return URL(string: "https://portal.dembrane.com")!
        case .echoNext:   return URL(string: "https://portal.echo-next.dembrane.com")!
        case .local:      return URL(string: "http://localhost:5174")!
        }
    }

    public var displayName: String {
        switch self {
        case .production: return "Production"
        case .echoNext:   return "echo-next"
        case .local:      return "Local"
        }
    }
}
