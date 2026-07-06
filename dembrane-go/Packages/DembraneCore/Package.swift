// swift-tools-version: 6.0
import PackageDescription

// DembraneCore — pure, cross-platform logic shared by the app, Share Extension,
// Widgets (Live Activity), and Watch app. Builds on macOS too, so `swift test`
// gives a fast CLI feedback loop with no simulator.
let package = Package(
    name: "DembraneCore",
    platforms: [
        .iOS("26.0"),
        .watchOS("26.0"),
        .macOS("14.0"),
    ],
    products: [
        .library(name: "DembraneCore", targets: ["DembraneCore"]),
    ],
    targets: [
        .target(name: "DembraneCore"),
        .testTarget(name: "DembraneCoreTests", dependencies: ["DembraneCore"]),
    ],
    // Scaffold in Swift 5 mode to keep the first build green; tighten to Swift 6
    // strict concurrency in a later hardening pass.
    swiftLanguageModes: [.v5]
)
