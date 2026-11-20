import SwiftUI
import XCTest
@testable import HealthRoadmap

/// Screenshots of the review page for the design review (design PR 15), from pages the real
/// engine draws over synthetic files. Runs only when TEST_RUNNER_UPLOAD_SHOTS names a folder.
@MainActor
final class UploadReviewShots: XCTestCase {
    typealias Drive = UploadPageTests.Drive

    func testShootTheReviewPage() throws {
        guard let out = ProcessInfo.processInfo.environment["UPLOAD_SHOTS"] else { throw XCTSkip("no shots folder") }
        var reading = try Drive()
        reading.step(["type": "picked", "needsConsent": false, "now": UploadPageTests.now,
                      "files": [["id": "z", "name": "health.zip", "bytes": 4000, "kind": "zip"]]])
        reading.step(["type": "listed", "run": reading.run, "zip": "z",
                      "members": (0..<12).map { ["id": "z#\($0)", "name": "report-\($0).pdf", "bytes": 300] }])
        reading.read("z#0", UploadPageTests.letter())
        reading.sending("z#1")

        var mixed = try Drive()
        mixed.pick(["Blood results", "Cardiology letter", "Discharge summary", "scan-3"])
        mixed.read("Blood results", UploadPageTests.lab(values: "\(UploadPageTests.ldl),\(UploadPageTests.unsureHdl)"))
        mixed.read("Cardiology letter", UploadPageTests.letter())
        mixed.read("Discharge summary", UploadPageTests.letter("Discharge summary", date: nil))
        mixed.sending("scan-3")
        mixed.step(["type": "sendFailed", "run": mixed.run, "id": "scan-3", "status": 503, "body": "{}", "contentType": "application/json"])

        var undated = try Drive()
        undated.pick(["Old results"])
        undated.read("Old results", UploadPageTests.lab(reportDate: nil, values: UploadPageTests.ldl))

        var done = try Drive()
        done.pick(["letter"])
        done.read("letter", UploadPageTests.letter())
        done.step(UploadAction.save.event(now: UploadPageTests.now))
        done.step(UploadSession.event(.success(.init(values: 3, documents: 1, archived: 0, unstored: 1)), run: done.run, attempt: 1))

        let pages = [("reading", try reading.page()), ("mixed", try mixed.page()), ("undated", try undated.page()), ("done", try done.page()), ("open", try mixed.page())]
        for (name, page) in pages {
            for (look, style, size) in [("light", UIUserInterfaceStyle.light, DynamicTypeSize.large), ("dark", .dark, .large), ("xxxl", .light, .accessibility3)] {
                for (device, width) in [("iphone", 390.0), ("ipad", 820.0)] where look == "light" || device == "iphone" {
                    try Self.shoot(page, open: name == "open" ? ["Cardiology letter"] : [], style: style, size: size, width: width, to: "\(out)/\(name)-\(device)-\(look).png")
                }
            }
        }
    }

    /// One page drawn in a window and written as a PNG (UploadSourcesTests shoots a photo and a scan with it).
    static func shoot(_ page: UploadPage, open: Set<String> = [], style: UIUserInterfaceStyle = .light, size: DynamicTypeSize = .large,
                      width: CGFloat = 390, to path: String) throws {
        let view = NavigationStack {
            UploadReviewView(page: page, send: { _ in }, letter: { _ in "## Plan\n\nWalk daily. Recheck the blood pressure in three months." }, open: open, finish: {})
                .navigationTitle("Add medical records")
                .navigationBarTitleDisplayMode(.inline)
        }
        .dynamicTypeSize(size)
        let host = UIHostingController(rootView: view)
        let height: CGFloat = open.isEmpty ? 1800 : 2600
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: height)
        window.overrideUserInterfaceStyle = style
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(1.5))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        try XCTUnwrap(image.pngData()).write(to: URL(fileURLWithPath: path))
        window.isHidden = true
    }
}
