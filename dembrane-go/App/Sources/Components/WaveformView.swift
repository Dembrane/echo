import SwiftUI
import DembraneCore

/// A live level meter: newest sample on the right, scrolling left (like the
/// Voice Memos / Music waveforms). Driven by `AppModel.audioLevels`.
struct WaveformView: View {
    var levels: [Float]
    var color: Color = BrandColor.royalBlue
    var barWidth: CGFloat = 3
    var spacing: CGFloat = 2

    var body: some View {
        GeometryReader { geo in
            HStack(alignment: .center, spacing: spacing) {
                ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                    Capsule()
                        .fill(color)
                        .frame(width: barWidth, height: max(2, CGFloat(level) * geo.size.height))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
            .clipped()
            .overlay {
                if levels.isEmpty {
                    Capsule().fill(color.opacity(0.25)).frame(height: 2)
                }
            }
        }
    }
}

#Preview {
    WaveformView(levels: (0..<40).map { _ in Float.random(in: 0.1...1) })
        .frame(height: 80).padding()
}
