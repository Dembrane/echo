import Foundation
import WatchConnectivity

/// Phone side of the Watch capture flow: receives audio files transferred from
/// the watch and hands them to the app to upload.
final class WatchConnectivityManager: NSObject, WCSessionDelegate {
    var onReceiveFile: ((URL) -> Void)?

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func session(_ session: WCSession, didReceive file: WCSessionFile) {
        // The inbox URL is reclaimed after this returns — copy it out first.
        let dest = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString + "-" + file.fileURL.lastPathComponent)
        try? FileManager.default.copyItem(at: file.fileURL, to: dest)
        guard FileManager.default.fileExists(atPath: dest.path) else { return }
        let handler = onReceiveFile
        DispatchQueue.main.async { handler?(dest) }
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { WCSession.default.activate() }
}
