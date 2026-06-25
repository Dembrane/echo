import SwiftUI
import DembraneCore

/// A live level meter. A fixed number of bars fill the width left→right (newest
/// on the right edge); only the heights animate, so it scrolls smoothly instead
/// of jittering as samples arrive (the layout never changes).
struct WaveformView: View {
    var levels: [Float]
    var color: Color = BrandColor.royalBlue
    var spacing: CGFloat = 2.5

    var body: some View {
        GeometryReader { geo in
            let count = max(levels.count, 1)
            let barWidth = max(1.5, (geo.size.width - spacing * CGFloat(count - 1)) / CGFloat(count))
            HStack(alignment: .center, spacing: spacing) {
                ForEach(0..<count, id: \.self) { index in
                    Capsule()
                        .fill(color)
                        .frame(width: barWidth, height: height(at: index, in: geo.size.height))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .leading)
            .animation(.easeOut(duration: 0.12), value: levels)
        }
    }

    private func height(at index: Int, in maxHeight: CGFloat) -> CGFloat {
        let level = index < levels.count ? CGFloat(levels[index]) : 0
        return max(2, level * maxHeight)
    }
}

#Preview {
    WaveformView(levels: (0..<48).map { _ in Float.random(in: 0.1...1) })
        .frame(height: 80).padding()
}
