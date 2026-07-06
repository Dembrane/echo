import SwiftUI
import UIKit

/// A shareable string identified for `.sheet(item:)` presentation.
struct ShareableText: Identifiable {
    let id = UUID()
    let text: String
}

/// A shareable file (e.g. exported audio) for `.sheet(item:)` presentation.
struct ShareableFile: Identifiable {
    let id = UUID()
    let url: URL
}

/// Arbitrary share items (text + image + url) for `.sheet(item:)` presentation.
struct ShareableItems: Identifiable {
    let id = UUID()
    let items: [Any]
}

/// Presents the system share sheet (UIActivityViewController) — used to trigger
/// Share from a swipe action / menu, where a SwiftUI `ShareLink` can't live.
struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]

    init(text: String) { items = [text] }
    init(url: URL) { items = [url] }
    init(items: [Any]) { self.items = items }

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
