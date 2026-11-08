import SwiftUI
import XCTest
@testable import HealthRoadmap

/// US-25 AC21d (break-test 2026-11-06): a double tap on a sheet's save, or on a row of the
/// Add supplement sheet, saves once and finishes once.
@MainActor
final class SheetSaveTests: XCTestCase {
    private final class Box { var saving = false; var saves = 0; var finishes = 0 }

    func testASecondRunWhileSavingDoesNothing_US25_AC21d() async {
        let box = Box()
        let saving = Binding(get: { box.saving }, set: { box.saving = $0 })
        let done = expectation(description: "the first save finishes")
        let save: () async -> RecordStore.ApplyResult = {
            box.saves += 1
            try? await Task.sleep(for: .milliseconds(100))
            return .saved()
        }
        SheetSave.run(saving, save) { _ in box.finishes += 1; done.fulfill() }
        XCTAssertTrue(box.saving, "saving is set in the tap")
        SheetSave.run(saving, save) { _ in box.finishes += 1 }
        await fulfillment(of: [done], timeout: 5)
        try? await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(box.saves, 1, "the second tap wrote nothing")
        XCTAssertEqual(box.finishes, 1, "the sheet closes once")
        XCTAssertFalse(box.saving, "Cancel works again")
    }
}
