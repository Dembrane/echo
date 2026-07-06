# Getting dembrane go onto TestFlight

Prereqs: the paid Apple Developer account (Team `JMCP69LCSU`), already signed into Xcode on this Mac.

## One-time — create the App Store Connect app record
The bundle id `com.dembrane.go` needs an app record before the first upload:
- Xcode usually offers to register it on first upload, **or**
- appstoreconnect.apple.com → Apps → **+** → New App → bundle id `com.dembrane.go`, name "dembrane go".

## Path A — Xcode (recommended for the first build, no extra tooling)
1. `open dembrane-go/DembraneGo.xcodeproj`
2. Scheme **DembraneGo**, destination **Any iOS Device (arm64)**.
3. **Product → Archive**.
4. In the Organizer: **Distribute App → TestFlight & App Store Connect → Upload**. Xcode manages the distribution certificate + profile automatically with your account.
5. Wait for processing in App Store Connect → **TestFlight** → add yourself as an internal tester → install via the TestFlight app.

This sidesteps headless-signing issues because Xcode has full keychain access.

## Path B — fastlane (repeatable / CI)
1. Create an App Store Connect API key: ASC → **Users and Access → Integrations → App Store Connect API → +** (role: App Manager). Download `AuthKey_XXXX.p8`, note the **Key ID** and **Issuer ID**.
2. Put the key at `dembrane-go/fastlane/AuthKey.p8` (git-ignored) and export:
   ```sh
   export ASC_KEY_ID=XXXXXXXXXX
   export ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```
3. Regenerate + ship:
   ```sh
   cd dembrane-go
   .tooling/xcodegen generate
   fastlane beta        # needs fastlane: `gem install fastlane`
   ```
   `beta` builds Release, app-store-signs via `-allowProvisioningUpdates`, and uploads to TestFlight.

## Already handled in the project
- **App icon** — brand logo at `App/Resources/Assets.xcassets/AppIcon.appiconset` (refine in M7).
- **Export compliance** — `ITSAppUsesNonExemptEncryption = NO` (HTTPS only), so no per-build prompt.
- Bundle id `com.dembrane.go`, version `0.1.0 (1)`, Team `JMCP69LCSU`.
