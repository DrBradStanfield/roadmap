import Foundation

/// The one door to the store's record for everything outside RecordStore*.swift (lead S52,
/// US-25 AC16f, AC21). A record an erase has since replaced, whose own draw failed
/// (`predatesErase`), reads as no record: nil, never the engine's empty record.
/// recordstore-access.test.ts fails on a read of `recordJSON`, `drawn` or `heldData` elsewhere.
extension RecordStore {
    struct Readable {
        let json: String
        let drawn: HealthEngine.Drawn?
    }

    /// Whether the record can be read or written (lead S55, US-25 AC16f, AC21): one answer, checked in
    /// order, read by `readable`, `applyInTurn`, the uploads and the charts. No stored state of its own.
    /// One row reads differently from before: a drawing with no stored record says `.empty`, so edits are
    /// refused where the old checks wrote. That row cannot occur: every drawing is `engine.screen` of the
    /// stored record and `screen("")` throws (ios/engine/my-data.ts), `.unreadable` clears both together,
    /// and init shows the load at once. Refusing is the safe side.
    enum Hold: Equatable {
        /// Drawn, no problem, no later erase: it reads and takes edits.
        case readable
        /// Stored, its draw failed with no problem to show (lead S67): it reads, `redraw` draws it again,
        /// and it takes no edit until then. Most often an erase held undrawn.
        case heldUndrawn
        /// No record stored: none loaded yet.
        case empty
        /// The record could not be read; `kept` when its stored text is still held.
        case unreadable(kept: Bool)
        /// A record an erase has since replaced, whose own draw failed (lead S52): it reads as none.
        case predatesErase
    }

    var hold: Hold {
        Self.hold(drawn: drawn != nil, problem: problem != nil, recordJSONEmpty: recordJSON.isEmpty, predatesErase: predatesErase)
    }
    nonisolated static func hold(drawn: Bool, problem: Bool, recordJSONEmpty: Bool, predatesErase: Bool) -> Hold {
        if predatesErase { return .predatesErase }
        if problem { return .unreadable(kept: !recordJSONEmpty) }
        if recordJSONEmpty { return .empty }
        return drawn ? .readable : .heldUndrawn
    }

    /// The record as stored and its drawing; nil while it predates an erase, or none is held.
    var readable: Readable? {
        switch hold {
        case .predatesErase, .empty, .unreadable(kept: false): nil
        case .readable, .heldUndrawn, .unreadable(kept: true): Readable(json: recordJSON, drawn: drawn)
        }
    }
    /// My health's rows and forms; nil while the record cannot be read.
    var myData: MyData? { readable?.drawn?.myData }
    /// My health's plan; nil while the record cannot be read.
    var plan: PlanState? { readable?.drawn?.plan }
    /// The plan's cards by topic, from the same call (US-73 AC3).
    var topics: TopicLayout? { readable?.drawn?.topics }
    /// The rows the store holds, read or not: its own sheet pins, marks and units keep reading them.
    var heldData: MyData? { drawn?.myData }
}
