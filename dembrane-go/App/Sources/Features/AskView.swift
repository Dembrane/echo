import SwiftUI
import DembraneCore

struct AskView: View {
    private let suggestions = [
        "What did I talk about this week?",
        "Summarize my last conversation.",
        "What decisions did we make?",
    ]

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Ask your conversations anything. The language model answers from your recordings and cites them.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)

                ForEach(suggestions, id: \.self) { suggestion in
                    Button {
                        // M4: open a chat seeded with this prompt
                    } label: {
                        Text(suggestion)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding()
                    }
                    .glassEffect(.regular, in: .rect(cornerRadius: 16))
                    .foregroundStyle(.primary)
                    .padding(.horizontal)
                }
                Spacer()
            }
            .padding(.top)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .navigationTitle("Ask")
        }
    }
}

#Preview {
    AskView()
}
