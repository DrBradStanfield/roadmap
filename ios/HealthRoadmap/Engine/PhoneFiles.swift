import Foundation
import os

/// The phone's record file and the marker that says the phone holds changes the
/// cloud lacks (US-25 AC11, US-09 AC4): plain files, so the engine reads and writes
/// them on its own queue and never waits on the main thread. The engine reaches them
/// through `EngineNatives` (`phoneRead`, `phoneWrite`, `pending`); their JavaScript
/// side is ios/engine/cloud-adapters.ts `CloudNatives`. `nil` URLs keep them in
/// memory (a quarantined self-test engine, EngineBoot).
final class PhoneFiles: Sendable {
    let record: URL?
    let pending: URL?
    /// In memory: the record (a quarantined engine has no files), the marker's
    /// generation when there is no marker file, and the highest generation set, so
    /// one set after a clear is still higher than any before it.
    private let memory = OSAllocatedUnfairLock(initialState: (record: String?.none, marker: 0, highest: 0))

    init(record: URL?, pending: URL?) {
        self.record = record
        self.pending = pending
    }

    /// The record's text, nil when there is none; throws when it is there but unreadable.
    func read() throws -> String? {
        guard let record else { return memory.withLock { $0.record } }
        guard FileManager.default.fileExists(atPath: record.path(percentEncoded: false)) else { return nil }
        return try String(contentsOf: record, encoding: .utf8)
    }

    func write(_ text: String) throws {
        guard let record else { return memory.withLock { $0.record = text } }
        try RecordStore.write(text, to: record)
    }

    func remove() {
        guard let record else { return memory.withLock { $0.record = nil } }
        try? FileManager.default.removeItem(at: record)
    }

    /// The pending marker as a generation (ios/engine/cloud.ts `pending`): "get",
    /// "set" (a higher generation), or "clear-if:<n>" (only while it is still at n).
    /// Answers the generation after; 0 when it is not set. A marker an older app wrote
    /// (empty) reads as generation 1.
    func pending(_ op: String) -> Int {
        marker { marker, highest in
            switch op {
            case "set":
                highest = max(highest, marker) + 1
                marker = highest
            case "clear-if:\(marker)":
                marker = 0
            default:
                break
            }
        }
    }

    /// A refused phone write puts back the generation it found, `previous` (0: none),
    /// while the marker is still the one it set: a session holding `previous` can
    /// still clear it. Swift's own; never a native the engine can call.
    func restore(_ previous: Int, ifStill generation: Int) {
        _ = marker { marker, _ in
            if marker == generation { marker = previous }
        }
    }

    /// Reads the marker, lets `change` move it, and keeps what it became.
    private func marker(_ change: (inout Int, inout Int) -> Void) -> Int {
        // Unchecked: `change` runs here, under the lock, and escapes nowhere.
        memory.withLockUnchecked { state in
            var marker = state.marker
            if let pending {
                marker = FileManager.default.fileExists(atPath: pending.path(percentEncoded: false))
                    ? (try? String(contentsOf: pending, encoding: .utf8)).flatMap { Int($0) } ?? 1 : 0
            }
            let found = marker
            change(&marker, &state.highest)
            guard marker != found else { return marker }
            if let pending {
                if marker == 0 { try? FileManager.default.removeItem(at: pending) } else { try? Data(String(marker).utf8).write(to: pending, options: .atomic) }
            } else {
                state.marker = marker
            }
            return marker
        }
    }
}
