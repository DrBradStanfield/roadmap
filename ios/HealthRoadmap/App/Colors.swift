import SwiftUI

/// The app's colour helpers, used on every tab (Brad 2026-10-23): a fixed colour per
/// light and dark mode, a system hue calmed for dark mode, and the label colour on an
/// accent-filled button. No twin: the web's colours are CSS.
extension Color {
    /// The same hue, calmer on a dark background (Brad 2026-10-23: system red and purple
    /// glare on black); unchanged in light mode.
    var softInDark: Color {
        let base = UIColor(self)
        return Color(uiColor: UIColor { traits in
            let color = base.resolvedColor(with: traits)
            guard traits.userInterfaceStyle == .dark else { return color }
            var hue: CGFloat = 0, saturation: CGFloat = 0, brightness: CGFloat = 0, alpha: CGFloat = 0
            guard color.getHue(&hue, saturation: &saturation, brightness: &brightness, alpha: &alpha) else { return color }
            return UIColor(hue: hue, saturation: saturation * 0.6, brightness: brightness * 0.9, alpha: alpha)
        })
    }

    /// A fixed colour for each mode, 0xRRGGBB.
    init(light: UInt32, dark: UInt32) {
        func rgb(_ hex: UInt32) -> UIColor {
            UIColor(red: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        }
        let (light, dark) = (rgb(light), rgb(dark))
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }
}

extension View {
    /// The label on an accent-filled button: OnAccent while it can be tapped, the
    /// system's dimmed colour while disabled (review R3).
    func onAccentLabel() -> some View { modifier(OnAccentLabel()) }
}

/// The app's filled accent button: a headline label, full width, OnAccent text (US-25
/// AC17c). Onboarding, the welcome screen, the tour's tip and the cloud prompt use it.
struct AccentButtonStyle: PrimitiveButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button(role: configuration.role, action: configuration.trigger) {
            configuration.label.font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6).onAccentLabel()
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
    }
}

extension PrimitiveButtonStyle where Self == AccentButtonStyle {
    static var accent: AccentButtonStyle { AccentButtonStyle() }
}

private struct OnAccentLabel: ViewModifier {
    @Environment(\.isEnabled) private var enabled

    func body(content: Content) -> some View {
        content.foregroundStyle(enabled ? Color.onAccent : Color.secondary)
    }
}
