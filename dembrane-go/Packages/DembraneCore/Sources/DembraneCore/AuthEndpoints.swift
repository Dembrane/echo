import Foundation

/// Directus-managed auth URLs (these live on the Directus host, not the API host).
public extension DembraneEndpoints {
    private var directus: URL { env.directusBaseURL }

    func directusLogin() -> URL { directus.appending(path: "auth/login") }
    func directusRefresh() -> URL { directus.appending(path: "auth/refresh") }
    func directusLogout() -> URL { directus.appending(path: "auth/logout") }
}
