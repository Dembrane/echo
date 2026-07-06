import CoreLocation
import Foundation
import MapKit

/// Best-effort "where was this recorded" naming, like Voice Memos. Entirely
/// optional: if permission is declined or anything fails, it returns nil and
/// the caller keeps the date-based name.
@MainActor
final class LocationNamer: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var authContinuation: CheckedContinuation<CLAuthorizationStatus, Never>?
    private var locContinuation: CheckedContinuation<CLLocation?, Never>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    /// A short place name for the current location, or nil.
    func currentPlaceName() async -> String? {
        let status = await ensureAuthorized()
        guard status == .authorizedWhenInUse || status == .authorizedAlways else { return nil }
        guard let location = await requestOnce() else { return nil }
        // iOS 26 reverse geocoding (CLGeocoder is deprecated → MapKit).
        guard let request = MKReverseGeocodingRequest(location: location) else { return nil }
        let mapItems = try? await request.mapItems
        return mapItems?.first?.name
    }

    private func ensureAuthorized() async -> CLAuthorizationStatus {
        let status = manager.authorizationStatus
        guard status == .notDetermined else { return status }
        return await withCheckedContinuation { continuation in
            authContinuation = continuation
            manager.requestWhenInUseAuthorization()
        }
    }

    private func requestOnce() async -> CLLocation? {
        await withCheckedContinuation { continuation in
            locContinuation = continuation
            manager.requestLocation()
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            let status = manager.authorizationStatus
            guard status != .notDetermined, let continuation = authContinuation else { return }
            authContinuation = nil
            continuation.resume(returning: status)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            guard let continuation = locContinuation else { return }
            locContinuation = nil
            continuation.resume(returning: locations.last)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            guard let continuation = locContinuation else { return }
            locContinuation = nil
            continuation.resume(returning: nil)
        }
    }
}
