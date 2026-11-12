import SwiftUI

extension View {
    /// For a tab with no title bar, My health's: iOS 26's edge effect leaves rows
    /// legible under the clock. An inset whose background reaches into the status bar hides them.
    /// Its height is the window controls' corner, so the title clears them: an iPhone app on an
    /// iPad (iPadOS 26) has them at the window's top left; on an iPhone the corner is zero.
    func solidStatusBar() -> some View { modifier(SolidStatusBar()) }
}

private struct SolidStatusBar: ViewModifier {
    @State private var controls: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .top, spacing: 0) {
                Color.clear.frame(height: controls).background(Color(uiColor: .systemGroupedBackground), ignoresSafeAreaEdges: .top)
            }
            // The corner is measured from the window's top; the screen already starts below the status bar.
            .onGeometryChange(for: CGFloat.self) { proxy in
                guard #available(iOS 26, *) else { return 0 }
                return max(0, proxy.containerCornerInsets.topLeading.height - proxy.frame(in: .global).minY)
            } action: { controls = $0 }
    }
}
