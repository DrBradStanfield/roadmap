import Foundation
import Observation

/// The user's record, one `health-roadmap.json` in the app's own storage
/// (US-25 AC4; the web keeps the same file in the user's cloud or the browser).
/// Every change goes through the engine's write rules, then to disk, and only
/// then to the screen. The web twin is widget-src/src/storage/roadmap-store.ts.
@MainActor
@Observable
final class RecordStore {
    enum ApplyResult: Equatable {
        case saved
        /// Nothing changed. `existingId` names the row that already holds that day.
        case refused(message: String, existingId: String?)
    }

    /// The record as stored, JSON text.
    private(set) var recordJSON: String
    /// What My data shows; nil while the record cannot be read.
    private(set) var myData: MyData?
    /// Why the record cannot be read, if it cannot. The app then writes nothing.
    private(set) var problem: String?

    private let engine: HealthEngine
    private let file: URL
    let deviceId: String

    init(folder: URL, engine: HealthEngine, deviceId: String) throws {
        self.engine = engine
        self.deviceId = deviceId
        file = folder.appending(path: "health-roadmap.json")
        if FileManager.default.fileExists(atPath: file.path()) {
            recordJSON = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
        } else {
            recordJSON = try engine.newRecord(now: .now, deviceId: deviceId)
            try Self.write(recordJSON, to: file)
        }
        do {
            myData = try engine.myData(recordJSON: recordJSON, now: .now, deviceId: deviceId)
        } catch {
            // A damaged file, or one a newer app wrote: keep it as it is for a later fix.
            problem = "Your saved record could not be read, so nothing will be saved over it. \(error.localizedDescription)"
        }
    }

    /// The folder the app keeps the record in: Application Support, made on first use.
    static func appFolder() throws -> URL {
        let folder = URL.applicationSupportDirectory
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    func apply(_ edit: RecordEdit) -> ApplyResult {
        if let problem { return .refused(message: problem, existingId: nil) }
        do {
            let outcome = try engine.apply(edit, to: recordJSON, now: .now, deviceId: deviceId)
            guard outcome.ok, let next = outcome.record else {
                return .refused(message: outcome.message ?? "That could not be saved.", existingId: outcome.existingId)
            }
            let shown = try engine.myData(recordJSON: next, now: .now, deviceId: deviceId)
            try Self.write(next, to: file)
            recordJSON = next
            myData = shown
            return .saved
        } catch {
            return .refused(message: error.localizedDescription, existingId: nil)
        }
    }

    /// Atomic, so a crash leaves the old record or the new one, never half of each;
    /// and locked by the phone's data protection whenever the phone is locked.
    private static func write(_ json: String, to file: URL) throws {
        try Data(json.utf8).write(to: file, options: [.atomic, .completeFileProtection])
    }
}
