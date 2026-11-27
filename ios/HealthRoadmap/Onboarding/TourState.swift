import SwiftUI

/// Where the tour is (US-57): the three tips in order, then done. Kept across launches in
/// TipKit's store (`Tour.step`); the screen-side modes are `TourState`'s.
enum TourStep: Int, Codable, Sendable, CaseIterable {
    case notStarted, snapshot, foundation, bloodTests, done

    /// The step after this tip: the next tip, or done.
    var next: TourStep { isTip ? TourStep(rawValue: rawValue + 1) ?? .done : self }

    /// One of the three tips, not before or after the tour.
    var isTip: Bool { self != .notStarted && self != .done }
}

/// The tour's one state (US-57 AC2): which tip is due, up or going, changed only by
/// `transition`. A due tip waits for its anchor to be on screen with the list at rest; it is
/// never lost to a scroll, only passed when its anchor does not exist (`noAnchor`).
enum TourState: Equatable {
    case notStarted
    /// `step`'s tip is due: it shows once its anchor is on screen and the list is at rest.
    case waiting(TourStep)
    /// The list is scrolling `step`'s anchor into view: the tip shows once it has arrived.
    case bringing(TourStep)
    /// `step`'s popover is up.
    case showing(TourStep)
    /// `step`'s tip was closed or acted on and its popover is going; what comes `then`
    /// waits until it has gone, so two presentations never overlap.
    case leaving(TourStep, then: Then)
    case finished

    enum Then: Equatable { case nextTip, labUpload }

    /// The state a saved step resumes in.
    init(_ step: TourStep) {
        switch step {
        case .notStarted: self = .notStarted
        case .done: self = .finished
        default: self = .waiting(step)
        }
    }

    /// The step to keep: a closed tip is never shown again, even while its popover goes.
    var step: TourStep {
        switch self {
        case .notStarted: .notStarted
        case .waiting(let step), .bringing(let step), .showing(let step): step
        case .leaving(let step, _): step.next
        case .finished: .done
        }
    }

    /// A tip is due, up or going: the rating prompt waits (AC8).
    var isRunning: Bool { self != .notStarted && self != .finished }

    /// What the screen reports, and what the tip's buttons send.
    enum Event: Equatable {
        /// Onboarding finished on My health (AC1).
        case started
        /// The person's third own save ends a running tour (review R2b).
        case ended
        /// What the list shows for the due tip while at rest: its anchor on screen or not (while
        /// bringing it in, whether it has arrived).
        case looked(TourStep, onScreen: Bool)
        /// This record has no anchor for `step` (no Weight & diabetes card): it passes (review R4).
        case noAnchor(TourStep)
        /// Next, Done, or a tap outside the popover (review R2a).
        case closed(TourStep)
        /// Tip 3's "Add a lab report" (AC7).
        case acted(TourStep)
        case skipped(TourStep)
        /// The popover has left the screen, for any reason.
        case gone(TourStep)
    }

    enum Effect: Equatable {
        case bringIntoView(TourStep)
        /// "Tour tip closed n" or "Tour skipped n".
        case logged(TourStep, skipped: Bool)
        case openLabUpload
        /// The tour ended by a tip: RootView then offers the cloud prompt (review R2c).
        case tourEnded
    }

    /// Pure: the next state and what to do. An event for a step that is not the current
    /// one (a late dismissal, a stale look) changes nothing.
    static func transition(_ state: TourState, _ event: Event) -> (TourState, [Effect]) {
        switch (state, event) {
        case (.notStarted, .started):
            return (.waiting(.snapshot), [])
        case (.waiting, .ended), (.bringing, .ended), (.showing, .ended), (.leaving, .ended):
            return (.finished, [])
        case (.waiting(let due), .looked(let step, let onScreen)) where step == due,
             (.bringing(let due), .looked(let step, let onScreen)) where step == due:
            return onScreen ? (.showing(due), []) : (.bringing(due), [.bringIntoView(due)])
        case (.waiting(let due), .noAnchor(let step)) where step == due,
             (.bringing(let due), .noAnchor(let step)) where step == due,
             (.showing(let due), .gone(let step)) where step == due:
            return passed(due)
        case (.showing(let up), .closed(let step)) where step == up:
            return up.next == .done ? passed(up) : (.leaving(up, then: .nextTip), [.logged(up, skipped: false)])
        case (.showing(let up), .acted(let step)) where step == up && up == .bloodTests:
            return (.leaving(up, then: .labUpload), [.logged(up, skipped: false)])
        case (.showing(let up), .skipped(let step)) where step == up:
            return (.finished, [.logged(up, skipped: true), .tourEnded])
        case (.leaving(let left, .nextTip), .gone(let step)) where step == left:
            return (TourState(left.next), [])
        case (.leaving(let left, .labUpload), .gone(let step)) where step == left:
            return (.finished, [.openLabUpload, .tourEnded])
        default:
            return (state, [])
        }
    }

    /// `step` closed with nothing up after it: the next tip is due, or the tour ends.
    private static func passed(_ step: TourStep) -> (TourState, [Effect]) {
        step.next == .done ? (.finished, [.logged(step, skipped: false), .tourEnded]) : (.waiting(step.next), [.logged(step, skipped: false)])
    }
}

/// Where a step's anchor is, for the scroll that brings it into view.
struct TourTarget: Equatable {
    /// The anchor's scroll id.
    let id: String
    /// Where the scroll puts it: the top for a heading the tip hangs under, else the middle.
    let atTop: Bool
}

/// How far the list can scroll, from its scroll geometry (iOS 18+).
struct TourScroll: Equatable {
    var offset: CGFloat
    var range: ClosedRange<CGFloat>
}

/// What My health's list shows, as the tour needs it: plain facts, never a mode. `look`
/// turns them into the event for the due tip.
struct TourSight: Equatable {
    /// My health's list is on screen: its tab, nothing pushed over it, no sheet up.
    var shown = false
    /// The first-run cover is up, or still going.
    var coverUp = false
    /// The person or iOS is scrolling the list (`onScrollPhaseChange`, iOS 18+). A scroll the
    /// app starts is not reported there; `arrived` sees its end instead.
    var moving = false
    /// The list's visible rect, safe areas taken off, in global coordinates.
    var bounds = CGRect.zero
    /// The list's offset and its limits; nil below iOS 18.
    var scroll: TourScroll?
    /// Each anchor's frame while its row is drawn: its row's frame, the insets a scroll aligns by included.
    var anchors: [TourStep: CGRect] = [:]
    /// Each step's anchor, for steps this record can draw.
    var targets: [TourStep: TourTarget] = [:]

    /// What prompted a look while the list brings an anchor in.
    enum Moment {
        /// Something moved (an anchor, the offset): only the anchor's arrival shows the tip.
        case moved
        /// The list came back (shown again, the cover gone, new anchors): arrival shows the tip, else scroll again.
        case returned
        /// The person's or iOS's own scroll ended: the tip shows if its anchor is on screen,
        /// wherever it stopped, else the list scrolls again (review R1).
        case stopped
    }

    /// The event for the due `step`, or nil while there is nothing to decide. While the list is
    /// bringing the anchor in, a tip never shows part-way through the tour's own scroll.
    func look(_ step: TourStep, bringing: Bool, after moment: Moment) -> TourState.Event? {
        guard shown, !coverUp else { return nil }
        guard targets[step] != nil else { return .noAnchor(step) }
        guard !moving else { return nil }
        guard bringing else { return .looked(step, onScreen: onScreen(step)) }
        if arrived(step) { return .looked(step, onScreen: true) }
        switch moment {
        case .moved: return nil
        case .returned: return .looked(step, onScreen: false)
        case .stopped: return .looked(step, onScreen: onScreen(step))
        }
    }

    /// Enough of `step`'s anchor shows to point at: all of it, or 44 points of a taller one.
    func onScreen(_ step: TourStep) -> Bool {
        guard let frame = anchors[step], !bounds.isEmpty else { return false }
        let seen = frame.intersection(bounds)
        return !seen.isNull && seen.height >= min(frame.height, 44) - 0.5
    }

    /// The scroll that brings `step`'s anchor in has ended: the anchor sits where the scroll puts
    /// it (top or middle), or the list cannot scroll further that way. Read from where things are,
    /// never from how long a scroll takes. Below iOS 18, with no scroll geometry, on screen is enough.
    func arrived(_ step: TourStep) -> Bool {
        guard let frame = anchors[step], let target = targets[step], frame.intersects(bounds) else { return false }
        guard let scroll else { return onScreen(step) }
        let still = target.atTop ? frame.minY - bounds.minY : frame.midY - bounds.midY
        return abs(still) <= Self.slack || (still > 0 && scroll.offset >= scroll.range.upperBound - 1)
            || (still < 0 && scroll.offset <= scroll.range.lowerBound + 1)
    }

    /// How near the spot counts as there. A scroll to the top leaves Blood tests' row 5 points above
    /// the list's top edge (its section spacing), and the list's last frames move it a few points
    /// at a time (both measured on iOS 27.2), so the tip may show with a few points still to go.
    static let slack: CGFloat = 12
}
