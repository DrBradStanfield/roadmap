import SwiftUI
import UIKit
import XCTest
@testable import HealthRoadmap

/// The opening never flashes (US-25 AC21b, Brad 2026-10-26): the system launch screen, the
/// app's LaunchView and My data share one background, light and dark, and LaunchView draws
/// nothing on it. Measured on an iPhone 15 Pro Max: LaunchView shows for about 100 ms.
@MainActor
final class LaunchScreenTests: XCTestCase {
    private let app = Bundle(for: RecordStore.self)
    private let light = UITraitCollection(userInterfaceStyle: .light)
    private let dark = UITraitCollection(userInterfaceStyle: .dark)

    func testTheSystemLaunchScreenUsesTheLaunchBackground_US25_AC21b() throws {
        let launch = try XCTUnwrap(app.object(forInfoDictionaryKey: "UILaunchScreen") as? [String: Any])
        XCTAssertEqual(launch["UIColorName"] as? String, "LaunchBackground")
    }

    func testTheLaunchBackgroundIsMyDatasBackgroundInBothAppearances_US25_AC21b() throws {
        let color = try XCTUnwrap(UIColor(named: "LaunchBackground", in: app, compatibleWith: nil))
        // Increase Contrast too: its light background is darker (235, 235, 240).
        let highLight = UITraitCollection(traitsFrom: [light, UITraitCollection(accessibilityContrast: .high)])
        let highDark = UITraitCollection(traitsFrom: [dark, UITraitCollection(accessibilityContrast: .high)])
        for traits in [light, dark, highLight, highDark] {
            assertSame(color.resolvedColor(with: traits), UIColor.systemGroupedBackground.resolvedColor(with: traits), traits)
        }
    }

    func testLaunchViewIsThePlainBackgroundWithNoMark_US25_AC21b() throws {
        for (scheme, traits) in [(ColorScheme.light, light), (.dark, dark)] {
            let renderer = ImageRenderer(content: LaunchView().frame(width: 60, height: 120).environment(\.colorScheme, scheme))
            renderer.scale = 1
            let image = try XCTUnwrap(renderer.uiImage?.cgImage)
            let pixels = try rgba(image)
            let first = Array(pixels[0..<4])
            for at in stride(from: 0, to: pixels.count, by: 4) where Array(pixels[at..<at + 4]) != first {
                return XCTFail("LaunchView draws something on its background (\(scheme))")
            }
            let expected = UIColor.systemGroupedBackground.resolvedColor(with: traits)
            assertSame(UIColor(red: CGFloat(first[0]) / 255, green: CGFloat(first[1]) / 255, blue: CGFloat(first[2]) / 255, alpha: 1), expected, traits)
        }
    }

    private func assertSame(_ a: UIColor, _ b: UIColor, _ traits: UITraitCollection, file: StaticString = #filePath, line: UInt = #line) {
        var (r1, g1, b1, a1, r2, g2, b2, a2) = (CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0))
        a.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        b.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        let close = [abs(r1 - r2), abs(g1 - g2), abs(b1 - b2), abs(a1 - a2)].allSatisfy { $0 < 0.004 }
        XCTAssertTrue(close, "\(a) vs \(b) in \(traits.userInterfaceStyle == .dark ? "dark" : "light")\(traits.accessibilityContrast == .high ? ", high contrast" : "")", file: file, line: line)
    }

    private func rgba(_ image: CGImage) throws -> [UInt8] {
        var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let context = try XCTUnwrap(CGContext(data: &pixels, width: image.width, height: image.height, bitsPerComponent: 8,
                                              bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return pixels
    }
}
