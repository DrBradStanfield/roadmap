import XCTest
@testable import HealthRoadmap

/// US-52 AC8b, AC8c: the upload sheet's one named state, moved only by `transition`. Every
/// event, from every step, and the steps it leaves alone. Files, Photos and Scan all take the
/// shared upload's one page; its own phases are the engine's.
@MainActor
final class LabUploadFlowTests: XCTestCase {
    typealias Step = LabUploadFlow.Step

    /// A step in words, so the table can compare steps that hold a session.
    private static func words(_ step: Step, _ session: UploadSession) -> String {
        switch step {
        case .choose: "choose"
        case .shared(let held): held === session ? "shared" : "shared (another)"
        case .failed(let m): "failed \(m)"
        case .finished: "finished"
        }
    }

    func testEveryEventMovesTheStepAsTheTableSays_US52_AC8c() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Flow \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = try RecordStore(folder: folder, engine: try HealthEngine(), deviceId: "test")
        let session = UploadSession(engine: store.engine, store: store)
        let other = UploadSession(engine: store.engine, store: store)
        defer { session.end(); other.end() }
        let table: [(String, Step, LabUploadFlow.Event, String)] = [
            ("a pick from any source goes to the shared page (its consent is the engine's phase)", .choose, .sharedPicked(session), "shared"),
            ("a second pick while one runs is ignored (a double tap starts one upload)", .shared(other), .sharedPicked(session), "shared (another)"),
            ("a pick after a refusal waits for Choose another file", .failed("No"), .sharedPicked(session), "failed No"),
            ("a pick after Done changes nothing", .finished, .sharedPicked(session), "finished"),
            ("a pick the reader refuses, or an engine too old for the upload", .shared(session), .failed("No"), "failed No"),
            ("a refusal from the sources", .choose, .failed("No"), "failed No"),
            ("Choose another file after a refusal", .failed("No"), .restart, "choose"),
            ("Choose another file from a refused page", .shared(session), .restart, "choose"),
            ("Stop sharing goes to the sources", .choose, .restart, "choose"),
            ("Done on the page closes", .shared(session), .done, "finished"),
            ("Done from the sources closes", .choose, .done, "finished"),
            ("a restart after Done starts cleanly", .finished, .restart, "choose"),
        ]
        for (name, from, event, expected) in table {
            XCTAssertEqual(Self.words(LabUploadFlow.transition(from, event), session), expected, name)
        }
    }
}
