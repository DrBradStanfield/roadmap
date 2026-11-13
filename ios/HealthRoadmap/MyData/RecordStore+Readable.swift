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

    /// The record as stored and its drawing; nil while it predates an erase, or none is held.
    var readable: Readable? { predatesErase || recordJSON.isEmpty ? nil : Readable(json: recordJSON, drawn: drawn) }
    /// My health's rows and forms; nil while the record cannot be read.
    var myData: MyData? { readable?.drawn?.myData }
    /// My health's plan; nil while the record cannot be read.
    var plan: PlanState? { readable?.drawn?.plan }
    /// The plan's cards by topic, from the same call (US-73 AC3).
    var topics: TopicLayout? { readable?.drawn?.topics }
    /// An erase held with no drawing (lead S67, US-25 AC16f): its record is stored but its draw
    /// failed, with no problem to show, and no later erase has replaced it. `redraw` draws it again;
    /// `applyInTurn` refuses edits while it holds.
    var heldUndrawn: Bool {
        Self.heldUndrawn(drawn: drawn != nil, problem: problem != nil, recordJSON: recordJSON, predatesErase: predatesErase)
    }
    nonisolated static func heldUndrawn(drawn: Bool, problem: Bool, recordJSON: String, predatesErase: Bool) -> Bool {
        !drawn && !problem && !recordJSON.isEmpty && !predatesErase
    }
    /// The rows the store holds, read or not: its own sheet pins, marks and units keep reading them.
    var heldData: MyData? { drawn?.myData }
}
