import SwiftUI
import UIKit

/// A calendar that opens with no day selected (PR 1908 fix round, item 6): one tap on any day up to
/// today, today included, picks it, so a picker never assumes a day the person did not tap.
/// SwiftUI's graphical DatePicker always shows a selection, and a tap on that day changes nothing.
struct DayCalendar: UIViewRepresentable {
    /// The day tapped, as a calendar day (YYYY-MM-DD).
    let picked: (String) -> Void
    /// A spoken name for the calendar (the view's words for the day it picks).
    let label: String

    func makeCoordinator() -> Coordinator { Coordinator(picked: picked) }

    func makeUIView(context: Context) -> UICalendarView {
        let view = Self.calendar(delegate: context.coordinator)
        view.accessibilityLabel = label
        return view
    }

    func updateUIView(_ view: UICalendarView, context: Context) {
        context.coordinator.picked = picked
    }

    /// The calendar in the phone's calendar, days up to today, single-day selection with none selected.
    static func calendar(delegate: Coordinator, now: Date = .now, calendar: Calendar = .current) -> UICalendarView {
        let view = UICalendarView()
        view.calendar = calendar
        view.availableDateRange = DateInterval(start: .distantPast, end: now)
        let selection = UICalendarSelectionSingleDate(delegate: delegate)
        selection.selectedDate = nil
        view.selectionBehavior = selection
        return view
    }

    final class Coordinator: NSObject, UICalendarSelectionSingleDateDelegate {
        var picked: (String) -> Void
        init(picked: @escaping (String) -> Void) { self.picked = picked }

        func dateSelection(_ selection: UICalendarSelectionSingleDate, didSelectDate components: DateComponents?) {
            guard let year = components?.year, let month = components?.month, let day = components?.day else { return }
            picked(String(format: "%04d-%02d-%02d", year, month, day))
        }
    }
}
