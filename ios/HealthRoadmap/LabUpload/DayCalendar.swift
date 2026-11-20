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
    // Always the app's Gregorian calendar (DayText): a phone set to the Japanese or Buddhist
    // calendar would otherwise send year 0008 or 2569.

    func makeUIView(context: Context) -> UICalendarView {
        let view = Self.calendar(delegate: context.coordinator)
        view.accessibilityLabel = label
        return view
    }

    func updateUIView(_ view: UICalendarView, context: Context) {
        context.coordinator.picked = picked
    }

    /// The calendar, Gregorian, days up to today, single-day selection with none selected.
    static func calendar(delegate: Coordinator, now: Date = .now, calendar: Calendar = DayText.gregorian) -> UICalendarView {
        let view = UICalendarView()
        view.calendar = calendar
        view.availableDateRange = DateInterval(start: .distantPast, end: now)
        delegate.calendar = calendar
        let selection = UICalendarSelectionSingleDate(delegate: delegate)
        selection.selectedDate = nil
        view.selectionBehavior = selection
        return view
    }

    final class Coordinator: NSObject, UICalendarSelectionSingleDateDelegate {
        var picked: (String) -> Void
        /// The calendar the view shows; a selection is read in its own calendar, else this one.
        var calendar = DayText.gregorian
        init(picked: @escaping (String) -> Void) { self.picked = picked }

        /// The tapped day through a Date, then written as a Gregorian day (DayText.iso), whatever the
        /// calendar the components came in.
        func dateSelection(_ selection: UICalendarSelectionSingleDate, didSelectDate components: DateComponents?) {
            guard var components else { return }
            let source = components.calendar ?? calendar
            components.hour = 12
            guard let date = source.date(from: components) else { return }
            picked(DayText.iso(date, calendar: source))
        }
    }
}
