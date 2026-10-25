// Draws the app icon from the welcome screen's logo (LogoMark): the original icon's white road
// with green lane dashes rising to a red heart on the green gradient (Brad 2026-10-25), as a
// full-bleed square (iOS masks the corners). It compiles the app's own LogoMark.swift, so icon
// and logo share one drawing. No SF Symbols, traced or not: their licence forbids them in app
// icons and logos (US-25 AC10).
// Run on the Mac, from the repo root (writes the 1024 px AppIcon PNG):
//   swiftc -parse-as-library ios/HealthRoadmap/App/LogoMark.swift ios/scripts/make-icon.swift \
//     -o "$TMPDIR/make-icon" && "$TMPDIR/make-icon"
import AppKit
import SwiftUI

@main
enum MakeIcon {
    @MainActor static func main() {
        let out = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../HealthRoadmap/Assets.xcassets/AppIcon.appiconset/AppIcon.png").standardized
        let renderer = ImageRenderer(content: LogoMark(fullBleed: true))
        renderer.scale = 1024 / 100
        // App Store icons must be opaque: redraw without an alpha channel.
        let ctx = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.draw(renderer.cgImage!, in: CGRect(x: 0, y: 0, width: 1024, height: 1024))
        let png = NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])!
        try! png.write(to: out)
        print("wrote", out.path)
    }
}
