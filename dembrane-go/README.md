# dembrane go

Native iOS / iPadOS / watchOS app to record conversations anywhere, transcribe
them on dembrane, and ask your conversations questions. See [DESIGN.md](DESIGN.md)
for the full product + design spec.

> Always write **dembrane** lowercase. Never use "ECHO" in user-facing copy.

## Status — M0 (scaffold) ✅

- 4-tab Liquid Glass shell (Record · Conversations · Ask · Settings) builds and
  runs on the iOS 26.5 simulator.
- `DembraneCore` Swift package (env, models, endpoints, SSE parser, API client +
  mock, brand tokens) with 21 passing unit tests.
- App unit tests pass on-simulator.

Next milestones (M1–M7) are in [DESIGN.md](DESIGN.md) §11.

## Prerequisites

- **Xcode 26.x** (iOS/watchOS 26 SDK). Verify: `xcodebuild -version`.
- **XcodeGen** — the project is generated from [`project.yml`](project.yml). A
  copy is vendored at `.tooling/xcodegen` (fetched from the GitHub release; no
  Homebrew needed). If you have your own: `brew install xcodegen`.

The `.xcodeproj` is generated and git-ignored — always regenerate, never edit it
by hand.

## Common commands (or use the [Makefile](Makefile))

```sh
# Regenerate the Xcode project from project.yml
.tooling/xcodegen generate            # make gen

# Fast logic tests (no simulator) — the tight feedback loop
cd Packages/DembraneCore && swift test   # make test-core

# Build the app for the iOS 26 simulator
xcodebuild build -project DembraneGo.xcodeproj -scheme DembraneGo \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -configuration Debug CODE_SIGNING_ALLOWED=NO   # make build

# Build + run the app unit tests on the simulator
xcodebuild test  -project DembraneGo.xcodeproj -scheme DembraneGo \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -configuration Debug CODE_SIGNING_ALLOWED=NO   # make test

# Install + launch on the booted simulator
make run
```

## Layout

```
dembrane-go/
  project.yml              XcodeGen spec (source of truth for the Xcode project)
  Makefile                 gen / test-core / build / test / run / clean
  App/
    Sources/               SwiftUI app: DembraneGoApp, RootView (tabs), Features/*, Components/*
    Tests/                 app unit tests (AppModelTests)
  Packages/DembraneCore/   shared logic package (+ its own swift-test suite)
  .tooling/                vendored xcodegen binary (git-ignored)
```

## Note on build settings

This machine has no XcodeGen `SettingPresets`, so a few Debug defaults that
XcodeGen normally injects are set explicitly in `project.yml`:
`PRODUCT_NAME=$(TARGET_NAME)`, `ONLY_ACTIVE_ARCH=YES` (Debug),
`ENABLE_TESTABILITY=YES`, and the test target's `BUNDLE_LOADER=$(TEST_HOST)`.
If you run on a machine with presets available, these are harmless.
