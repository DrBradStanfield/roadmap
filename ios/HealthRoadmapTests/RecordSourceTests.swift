import os
import XCTest
@testable import HealthRoadmap

/// RecordStore.Source.transition, cell by cell (US-25 AC11; leads S10, S23, H28): three states by
/// seven events, one row each. A drop cell is one no caller reaches today: nothing moves and nothing
/// is drawn. The behaviour through the store: RecordSourcePinsTests.
@MainActor
final class RecordSourceTests: XCTestCase {
    private typealias Source = RecordStore.Source

    private let pending = PhoneFiles(record: nil, pending: nil)
    private var link: Source.Link { Source.Link(account: "dropbox:a", pending: pending) }
    private var other: Source.Link { Source.Link(account: "dropbox:b", pending: pending) }
    private var cloud: Source.Cloud { Source.Cloud(erase: "e-1", session: 7, link: link) }

    func testEveryCell() {
        let phone = Source.phone(link: link)
        let leaving = Source.leaving(from: cloud)
        let open = Source.cloud(cloud)
        let rows: [(String, Source, Source.Event, Source, Source.Effect)] = [
            // On the phone's file.
            ("phone × linked", phone, .linked(other), .phone(link: other), .none),
            ("phone × cloudShown", phone, .cloudShown(erase: "e-2", session: 8), .cloud(.init(erase: "e-2", session: 8, link: link)), .show),
            ("phone × cloudEdited", phone, .cloudEdited(erase: "e-2"), phone, .drop),
            ("phone × phoneRequested", phone, .phoneRequested, phone, .none),
            ("phone × phoneLoaded", phone, .phoneLoaded, phone, .show),
            ("phone × phoneUnreadable", phone, .phoneUnreadable, phone, .unreadable),
            ("phone × phoneWritten", phone, .phoneWritten, phone, .show),
            // showPhone's read: the cloud is still on screen.
            ("leaving × linked", leaving, .linked(nil), .leaving(from: .init(erase: "e-1", session: 7, link: nil)), .none),
            ("leaving × cloudShown", leaving, .cloudShown(erase: "e-2", session: 8), leaving, .drop),
            ("leaving × cloudEdited", leaving, .cloudEdited(erase: "e-2"), leaving, .drop),
            ("leaving × phoneRequested", leaving, .phoneRequested, leaving, .drop),
            ("leaving × phoneLoaded", leaving, .phoneLoaded, .phone(link: link), .show),
            ("leaving × phoneUnreadable", leaving, .phoneUnreadable, .phone(link: link), .unreadable),
            ("leaving × phoneWritten", leaving, .phoneWritten, leaving, .drop),
            // A cloud record open.
            ("cloud × linked", open, .linked(other), .cloud(.init(erase: "e-1", session: 7, link: other)), .none),
            ("cloud × cloudShown", open, .cloudShown(erase: "e-2", session: 8), .cloud(.init(erase: "e-2", session: 8, link: link)), .show),
            ("cloud × cloudEdited", open, .cloudEdited(erase: "e-2"), .cloud(.init(erase: "e-2", session: 7, link: link)), .show),
            ("cloud × phoneRequested", open, .phoneRequested, leaving, .none),
            ("cloud × phoneLoaded", open, .phoneLoaded, open, .drop),
            ("cloud × phoneUnreadable", open, .phoneUnreadable, open, .drop),
            ("cloud × phoneWritten", open, .phoneWritten, open, .drop),
        ]
        XCTAssertEqual(rows.count, 21, "three states by seven events")
        for (cell, state, event, next, effect) in rows {
            let step = Source.transition(state, event)
            XCTAssertEqual(step.next, next, cell)
            XCTAssertEqual(step.effect, effect, cell)
        }
    }

    /// A link compares its pending marker by identity: another PhoneFiles is another link.
    func testALinkIsItsAccountAndItsMarker() {
        XCTAssertEqual(link, Source.Link(account: "dropbox:a", pending: pending))
        XCTAssertNotEqual(link, other)
        XCTAssertNotEqual(link, Source.Link(account: "dropbox:a", pending: PhoneFiles(record: nil, pending: nil)))
    }

    /// CloudSync links the store after every send: an equal link assigns nothing, so nothing that
    /// watches the source moves (the land door assigns only on change).
    func testAnEqualLinkAssignsNothing() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Record Source \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = try RecordStore(folder: folder, engine: HealthEngine(), deviceId: "ios-test")
        store.link(link)
        XCTAssertEqual(store.source, .phone(link: link))
        // Observation calls onChange as the property is about to be set, in the same turn.
        let moved = OSAllocatedUnfairLock(initialState: false)
        withObservationTracking { _ = store.source } onChange: { moved.withLock { $0 = true } }
        store.link(Source.Link(account: "dropbox:a", pending: pending))
        XCTAssertFalse(moved.withLock { $0 }, "an equal link assigns nothing")
        store.link(other)
        XCTAssertTrue(moved.withLock { $0 }, "a new one does")
        XCTAssertEqual(store.source, .phone(link: other))
    }
}
