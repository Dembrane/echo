import SwiftUI
import UIKit

/// A shareable string identified for `.sheet(item:)` presentation.
struct ShareableText: Identifiable {
    let id = UUID()
    let text: String
}

/// Presents the system share sheet (UIActivityViewController) — used to trigger
/// Share from a swipe action, where a SwiftUI `ShareLink` can't live.
struct ActivityView: UIViewControllerRepresentable {
    let text: String

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [text], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
