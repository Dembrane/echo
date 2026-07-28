import Foundation

public extension URL {
    /// dembrane Go's analytics source tag.
    static let goUTMSource = "dembrane_go_ios"

    /// Append `utm_source` so dembrane analytics (PostHog) can attribute web
    /// traffic that originates from the iOS app: register, legal pages, the
    /// dashboard, and the participant portal link. Idempotent — won't double-add.
    func appendingUTMSource(_ source: String = URL.goUTMSource) -> URL {
        guard var comps = URLComponents(url: self, resolvingAgainstBaseURL: false) else { return self }
        var items = comps.queryItems ?? []
        guard !items.contains(where: { $0.name == "utm_source" }) else { return self }
        items.append(URLQueryItem(name: "utm_source", value: source))
        comps.queryItems = items
        return comps.url ?? self
    }
}
