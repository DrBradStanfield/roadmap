import SwiftUI

extension View {
    /// A diagram's card (the sync, upload and reading diagrams): a fill that stands
    /// off any background, light or dark, and a hairline edge that follows Increase Contrast. A grouped background
    /// vanished into its own list row in dark mode (checked 2026-10-23).
    func diagramCard(cornerRadius: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        return background(Color(.tertiarySystemFill), in: shape)
            .overlay(shape.strokeBorder(Color(.separator)))
    }
}
