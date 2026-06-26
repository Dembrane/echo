import SwiftUI

/// Minimal block-level markdown renderer. SwiftUI's `Text(AttributedString)` only
/// applies *inline* markdown (bold/italic/links) — it won't render block lists or
/// headings. This splits the text into blocks and renders each, so bullet and
/// numbered lists actually look like lists. Inline styling is still applied per line.
struct MarkdownText: View {
    let markdown: String
    var spacing: CGFloat = 6

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            ForEach(Array(Self.parse(markdown).enumerated()), id: \.offset) { _, block in
                block.view
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    fileprivate enum Block {
        case heading(String, level: Int)
        case bullet(String)
        case numbered(Int, String)
        case paragraph(String)

        @ViewBuilder var view: some View {
            switch self {
            case .heading(let t, let level):
                Text(inline(t))
                    .font(level <= 1 ? .headline : .subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
            case .bullet(let t):
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("•").foregroundStyle(.secondary)
                    Text(inline(t)).frame(maxWidth: .infinity, alignment: .leading)
                }
            case .numbered(let n, let t):
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(n).").foregroundStyle(.secondary).monospacedDigit()
                    Text(inline(t)).frame(maxWidth: .infinity, alignment: .leading)
                }
            case .paragraph(let t):
                Text(inline(t)).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    fileprivate static func parse(_ md: String) -> [Block] {
        var blocks: [Block] = []
        for raw in md.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            if line.hasPrefix("#") {
                let level = line.prefix(while: { $0 == "#" }).count
                let text = line.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces)
                blocks.append(.heading(text, level: level))
            } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                blocks.append(.bullet(String(line.dropFirst(2))))
            } else if let item = numbered(line) {
                blocks.append(.numbered(item.0, item.1))
            } else {
                blocks.append(.paragraph(line))
            }
        }
        return blocks
    }

    /// "3. text" → (3, "text"); nil otherwise.
    private static func numbered(_ line: String) -> (Int, String)? {
        guard let dot = line.firstIndex(of: "."),
              let n = Int(line[line.startIndex..<dot]),
              line.index(after: dot) < line.endIndex,
              line[line.index(after: dot)] == " " else { return nil }
        return (n, String(line[line.index(dot, offsetBy: 2)...]))
    }
}

/// Inline markdown (bold/italic/links), whitespace preserved — safe while a
/// response is still streaming in.
private func inline(_ s: String) -> AttributedString {
    (try? AttributedString(
        markdown: s,
        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        ?? AttributedString(s)
}
