#if canImport(SwiftUI)
import SwiftUI

/// dembrane brand palette (see echo/brand/colors.json). Shared by the app,
/// widgets, and watch app.
public enum BrandColor {
    public static let parchment    = Color(brandHex: 0xF6F4F1) // background / canvas
    public static let graphite     = Color(brandHex: 0x2D2D2C) // primary text
    public static let royalBlue    = Color(brandHex: 0x4169E1) // primary action
    public static let cyan         = Color(brandHex: 0x00FFFF) // accent
    public static let springGreen  = Color(brandHex: 0x1EFFA1) // accent
    public static let mauve        = Color(brandHex: 0xFFC2FF) // accent
    public static let limeCream    = Color(brandHex: 0xF4FF81) // accent
    public static let goldenPollen = Color(brandHex: 0xFFD166) // warning
    public static let cottonCandy  = Color(brandHex: 0xFF9AA2) // error
}

public extension Color {
    init(brandHex hex: UInt32) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self = Color(.sRGB, red: r, green: g, blue: b, opacity: 1)
    }
}

/// DM Sans is bundled in the app and registered at launch; if it isn't present
/// we fall back to the system font rather than crashing.
public enum BrandFont {
    public static let family = "DMSans"

    public static func body(_ size: CGFloat = 20) -> Font { custom(size) }
    public static func title(_ size: CGFloat = 26) -> Font { custom(size) }
    public static func caption(_ size: CGFloat = 13) -> Font { custom(size) }

    private static func custom(_ size: CGFloat) -> Font {
        Font.custom(family, size: size)
    }
}
#endif
