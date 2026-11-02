import SwiftUI
import UIKit
import XCTest
@testable import HealthRoadmap

/// US-58 AC7 (Brad 2026-10-31): each Apple Health page (heart rate, resting heart rate, sleep,
/// VO2 max, steps) ends with its "About" guide, the same `GuideSections` a record metric's
/// page shows. Each page is drawn for real on a fake Health store, with the guide the engine
/// serves under the metric's `guideKey`, then drawn again without it: the guide must add its
/// sections below the page's own content. (SwiftUI builds no accessibility tree for a unit
/// test's window, so the words are checked by eye.) With `TEST_RUNNER_GUIDE_SHOTS` set to a
/// folder, each page with its guide is saved there as a PNG, light and dark.
@MainActor
final class LiveGuidePageTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_793_440_000) // 2026-10-31
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        return calendar
    }

    func testEachAppleHealthPageShowsItsGuide_US58_AC7() async throws {
        let engine = try HealthEngine()
        let empty = try engine.blocking { [now] in
            try $0.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!)
        }
        let guides = try XCTUnwrap(try engine.blocking { [now] in try $0.myData(recordJSON: empty, now: now, deviceId: "test") }.guides)
        let shots = ProcessInfo.processInfo.environment["GUIDE_SHOTS"].map { URL(filePath: $0, directoryHint: .isDirectory) }
        for metric in LiveMetric.allCases {
            let guide = try XCTUnwrap(guides[metric.guideKey], metric.rawValue)
            for style in [UIUserInterfaceStyle.light, .dark] {
                let name = "\(metric.guideKey) \(style == .dark ? "dark" : "light")"
                let bare = try await draw(metric, guide: nil, style: style)
                let shown = try await draw(metric, guide: guide, style: style)
                // The guide's sections run on well below the page's own content: its four parts
                // and its sources are several hundred points tall at the default text size.
                let added = Self.contentBottom(shown) - Self.contentBottom(bare)
                XCTAssertGreaterThan(added, 500, "\(name): the guide adds \(added) pt")
                if let shots {
                    try shown.pngData()?.write(to: shots.appending(path: "\(metric.guideKey)-\(style == .dark ? "dark" : "light").png"))
                }
            }
        }
    }

    /// The page, pushed in a navigation stack as My data pushes it, drawn on a fake Health store.
    private func draw(_ metric: LiveMetric, guide: MetricGuide?, style: UIUserInterfaceStyle) async throws -> UIImage {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 2600)
        window.overrideUserInterfaceStyle = style
        window.rootViewController = UIHostingController(rootView: NavigationStack {
            LiveHealthPage(live: live, metric: metric, guide: guide)
        })
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .seconds(1.5))
        return UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
    }

    /// The lowest point, in points, where anything is drawn over the page's background
    /// (the colour at the bottom-left corner).
    private static func contentBottom(_ image: UIImage) -> CGFloat {
        guard let cg = image.cgImage, let data = cg.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return 0 }
        let (width, height, row, step) = (cg.width, cg.height, cg.bytesPerRow, cg.bitsPerPixel / 8)
        let pixel = { (x: Int, y: Int) in (0..<3).map { Int(bytes[y * row + x * step + $0]) } }
        let background = pixel(1, height - 1)
        for y in stride(from: height - 1, through: 0, by: -1) {
            for x in stride(from: 0, to: width, by: 2) where zip(pixel(x, y), background).contains(where: { abs($0 - $1) > 8 }) {
                return CGFloat(y) / image.scale
            }
        }
        return 0
    }
}
