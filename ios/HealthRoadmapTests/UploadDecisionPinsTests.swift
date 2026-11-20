import UIKit
import XCTest
@testable import HealthRoadmap

/// Shared upload PR 1 (US-52 AC7, AC8): golden pins of the phone's upload decisions today,
/// read from the table the web runs too (packages/health-core/src/__fixtures__/upload-decisions.json,
/// copied here by ios/scripts/build-engine.mjs; the web: widget-src/src/lib/upload-decisions.pins.test.tsx).
/// The rows the app's own Swift rules answered (kinds, sizes, ZIP members and counts, failure words,
/// review defaults, what blocks Save) moved into health-core with the one upload flow (Q4): the web's
/// pins and upload-rules tests hold them, and UploadRulesDoorTests checks the door answers them.
/// Synthetic names and bytes only.
@MainActor
final class UploadDecisionPinsTests: XCTestCase {
    private typealias Row = [String: Any]

    private func table() throws -> Row {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "upload-decisions", withExtension: "json"),
                                "the upload table is missing; run ios/scripts/build-engine.mjs")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? Row)
    }

    private func rows(_ section: String) throws -> [Row] {
        try XCTUnwrap((try table()[section] as? Row)?["rows"] as? [Row], section)
    }

    /// A name from the table: a string, or pieces where {repeat, times} is that many copies.
    private func text(_ spec: Any?) -> String {
        let pieces = spec as? [Any] ?? [spec as Any]
        return pieces.map { piece in
            if let piece = piece as? String { return piece }
            let repeated = piece as? Row ?? [:]
            return String(repeating: repeated["repeat"] as? String ?? "", count: repeated["times"] as? Int ?? 0)
        }.joined()
    }

    private let now = try! Date("2026-10-21T08:00:00.000Z", strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    private let png = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { _ in }
    private let pdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 200, height: 200)).pdfData { $0.beginPage() }

    // MARK: photo size (D10)

    func testAPickedPhotoIsSentAtItsLongSide() throws {
        let px = try XCTUnwrap((try table()["photoResize"] as? Row)?["phone"] as? Int)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let big = UIGraphicsImageRenderer(size: CGSize(width: 3000, height: 1000), format: format).image { _ in }
        let page = try XCTUnwrap(LabFileReader.jpegPage(big))
        let sent = try XCTUnwrap(UIImage(data: XCTUnwrap(Data(base64Encoded: page.content))))
        XCTAssertEqual(sent.size.width * sent.scale, CGFloat(px))
    }

    // MARK: naming (D13)

    func testEachFilesSourceFileName() async throws {
        let engine = try HealthEngine()
        for row in try rows("naming") {
            let document: LabFileReader.Document
            if row["kind"] as? String == "zip" {
                let zip = try XCTUnwrap(row["zip"] as? String), path = text(row["path"])
                document = LabFileReader.Document(name: "\(zip)/\(path)", pages: [], truncated: false, zipMember: .init(zip: zip, path: path))
            } else {
                document = LabFileReader.Document(name: text(row["name"]), pages: [], truncated: false)
            }
            let named = await engine.named([document]).map(\.name)
            XCTAssertEqual(named, [text(row["phone"])], document.name)
        }
    }
}
