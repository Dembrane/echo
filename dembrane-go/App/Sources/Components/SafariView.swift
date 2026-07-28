import SwiftUI
import SafariServices

/// In-app browser (SFSafariViewController) so web flows like password reset
/// stay inside the app instead of bouncing to Safari — App Review guideline 4.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

extension View {
    /// Presents `url` in an in-app Safari sheet whenever it's non-nil.
    func safariSheet(url: Binding<URL?>) -> some View {
        sheet(item: url) { SafariView(url: $0).ignoresSafeArea() }
    }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}
