import SwiftUI
import DembraneCore

/// Asks for permission to send recordings to AI, and says what goes where. Apple
/// requires explicit permission before personal data reaches a third-party AI
/// (App Review Guideline 5.1.2(i)). dembrane transcribes and analyses with Google
/// Cloud Vertex AI in the EU, as its privacy policy lists; keep the two in step.
struct AIConsentView: View {
    @Environment(AppModel.self) private var model
    /// "Not now" closes the screen this sits in; nil hides it where leaving the
    /// screen is the way to say no (the Ask tab).
    var onNotNow: (() -> Void)?
    @State private var safariURL: URL?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Image(systemName: "sparkles")
                    .font(.largeTitle).foregroundStyle(BrandColor.royalBlue)
                    .accessibilityHidden(true)
                Text("Before you record")
                    .font(.title.weight(.semibold))
                Text("dembrane turns what you record into transcripts, summaries and answers with AI. It needs your permission to send your recordings for this.")
                    .font(.callout).foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 14) {
                    point("waveform", "What is sent",
                          "The audio you record or share to dembrane Go, and the questions you ask in Ask.")
                    point("building.2", "Who processes it",
                          "dembrane, on servers in the EU, and Google Cloud Vertex AI in the EU, which transcribes and analyses it for dembrane.")
                    point("person.2", "Who sees the results",
                          "You and the people with access to the project you record into.")
                    point("hand.raised", "Your choice",
                          "You can withdraw this in Settings. Recordings already sent stay in your projects until you delete them.")
                }

                Button("Privacy policy") {
                    safariURL = URL(string: "https://www.dembrane.com/legal/privacy")!.appendingUTMSource()
                }
                .font(.callout).tint(BrandColor.royalBlue)

                Text("Let the people you record know that you are recording.")
                    .font(.caption).foregroundStyle(.secondary)

                VStack(spacing: 10) {
                    Button {
                        model.setAIConsent(true)
                    } label: {
                        Text("Allow").font(.headline).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent).controlSize(.large).tint(BrandColor.royalBlue)
                    if let onNotNow {
                        Button("Not now", action: onNotNow)
                            .font(.callout).tint(.secondary)
                    }
                }
                .padding(.top, 4)
            }
            .padding(28)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .safariSheet(url: $safariURL)
    }

    private func point(_ symbol: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.title3).foregroundStyle(BrandColor.royalBlue)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    AIConsentView(onNotNow: {}).environment(AppModel.makeMock())
}
