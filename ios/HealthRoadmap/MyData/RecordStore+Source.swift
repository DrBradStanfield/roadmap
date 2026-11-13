import Foundation

/// Which record the store shows, the phone's file or a cloud record (US-25 AC11), as one value:
/// `Source`, changed only by its pure `transition` (leads S10, S23, H28). RecordStore lands each
/// event through one private door (`land`, RecordStore.swift), inside a chained step, except
/// CloudSync's `link`, which is synchronous.
extension RecordStore {
    enum Source: Equatable {
        /// The phone's file. `link`: the connected cloud, while its record is not open.
        case phone(link: Link?)
        /// showPhone's read of the phone's file: the screen still draws the cloud's record and
        /// reports it, so nothing taken meanwhile is checked against the phone (S10).
        case leaving(from: Cloud)
        /// A cloud record, opened in the engine's session.
        case cloud(Cloud)

        /// The connected cloud, set only by CloudSync (`RecordStore.link`, S23).
        struct Link: Equatable {
            /// Provider and account: Apple Health's erase-gate source (US-72 AC10).
            let account: String
            /// The marker a phone edit sets in the step that writes it, so the next open merges
            /// it up (US-09 AC4).
            let pending: PhoneFiles

            static func == (lhs: Link, rhs: Link) -> Bool { lhs.account == rhs.account && lhs.pending === rhs.pending }
        }

        struct Cloud: Equatable {
            /// The erase the screen shows. Every edit goes through the engine's session, which
            /// refuses one made for another erase.
            let erase: String
            /// The engine session the record came from.
            let session: Int
            /// CloudSync's link now: a switch may replace it while this record is still shown.
            let link: Link?
            /// The link's account, set when a session's first record is drawn; a re-read, an edit or
            /// an erase in the same session keeps it; a link never moves it. So a record is never
            /// named after an account it does not come from (US-72 AC10). Engine sessions only rise
            /// (ios/engine/cloud.ts), so the session alone tells a re-read from a new open.
            let drawnAccount: String?

            func linked(_ link: Link?) -> Cloud { Cloud(erase: erase, session: session, link: link, drawnAccount: drawnAccount) }
        }

        enum Event: Equatable {
            /// CloudSync's link after each change to its connection; nil with no cloud.
            case linked(Link?)
            /// A record the session sent: showCloud, handOver, showErased.
            case cloudShown(erase: String, session: Int)
            /// A record an edit made through the open session.
            case cloudEdited(erase: String)
            /// showPhone begins.
            case phoneRequested
            /// The phone's file, read: at launch and when showPhone's read lands.
            case phoneLoaded
            /// showPhone's read failed.
            case phoneUnreadable
            /// An edit or an erase written to the phone's file.
            case phoneWritten
        }

        /// What the store does with the record, the drawing and the problem the event came with.
        enum Effect: Equatable {
            /// Only the source moves.
            case none
            /// They are shown.
            case show
            /// No drawing and no record text (as a file that cannot be read, RecordFile.loadPhone); the problem is shown.
            case unreadable
            /// A cell no caller reaches today (every record step is chained): nothing moves,
            /// so a future unchained caller draws nothing instead of mixing two records.
            case drop
        }

        /// One row per cell, no default arm: a new state or event must decide every cell.
        static func transition(_ state: Source, _ event: Event) -> (next: Source, effect: Effect) {
            switch (state, event) {
            case (.phone, .linked(let link)): (.phone(link: link), .none)
            case (.phone(let link), .cloudShown(let erase, let session)): (.cloud(Cloud(erase: erase, session: session, link: link, drawnAccount: link?.account)), .show)
            case (.phone, .cloudEdited): (state, .drop)
            case (.phone, .phoneRequested): (state, .none)
            case (.phone, .phoneLoaded): (state, .show)
            case (.phone, .phoneUnreadable): (state, .unreadable)
            case (.phone, .phoneWritten): (state, .show)

            case (.leaving(let from), .linked(let link)): (.leaving(from: from.linked(link)), .none)
            case (.leaving, .cloudShown): (state, .drop)
            case (.leaving, .cloudEdited): (state, .drop)
            case (.leaving, .phoneRequested): (state, .drop)
            case (.leaving(let from), .phoneLoaded): (.phone(link: from.link), .show)
            case (.leaving(let from), .phoneUnreadable): (.phone(link: from.link), .unreadable)
            case (.leaving, .phoneWritten): (state, .drop)

            case (.cloud(let cloud), .linked(let link)): (.cloud(cloud.linked(link)), .none)
            case (.cloud(let cloud), .cloudShown(let erase, let session)):
                (.cloud(Cloud(erase: erase, session: session, link: cloud.link,
                              drawnAccount: session == cloud.session ? cloud.drawnAccount : cloud.link?.account)), .show)
            case (.cloud(let cloud), .cloudEdited(let erase)): (.cloud(Cloud(erase: erase, session: cloud.session, link: cloud.link, drawnAccount: cloud.drawnAccount)), .show)
            case (.cloud(let cloud), .phoneRequested): (.leaving(from: cloud), .none)
            case (.cloud, .phoneLoaded): (state, .drop)
            case (.cloud, .phoneUnreadable): (state, .drop)
            case (.cloud, .phoneWritten): (state, .drop)
            }
        }

        /// The erase the screen reports: the cloud's until the phone's record lands.
        var erase: String? {
            switch self {
            case .phone: nil
            case .leaving(let cloud), .cloud(let cloud): cloud.erase
            }
        }

        /// Which record is shown, for Apple Health's erase gate (US-72 AC10): "phone"; the account
        /// a cloud record was drawn under while the link still names it; nil while a connected
        /// cloud's record is not open, while showPhone reads the phone's file, and while a switch's
        /// link disagrees with the record shown. Nil: the gate decides nothing.
        var recordSource: String? {
            switch self {
            case .phone(let link): link == nil ? "phone" : nil
            case .leaving: nil
            case .cloud(let cloud): cloud.link?.account == cloud.drawnAccount ? cloud.drawnAccount : nil
            }
        }

        /// The connected cloud, in any state.
        var link: Link? {
            switch self {
            case .phone(let link): link
            case .leaving(let cloud), .cloud(let cloud): cloud.link
            }
        }
    }

    var screen: Screen {
        Screen(erase: source.erase, epoch: myData?.eraseEpoch, erasures: erasures, units: myData?.unitSystem ?? "si", choices: unitChoices.json, lpaUnit: myData?.lpaUnit ?? "")
    }

    /// While a cloud record is shown (US-25 AC11): the erase the screen shows. Nil: the record is
    /// the phone's file, written here.
    var cloudErase: String? { screen.erase }

    // MARK: Cloud (US-25 AC11)

    /// Show the cloud record the engine opened or took in, and send edits to it.
    /// A record the screen cannot draw is not shown; the last good one stays.
    @discardableResult
    func showCloud(_ view: HealthEngine.CloudView) -> Task<Void, Never> {
        chain { await self.draw(view) }
    }

    /// The cloud handover (CloudSync's open), as one step in line: every edit asked for
    /// before it has landed on the phone's file and been counted when `decide` runs.
    /// `decide` answers whether to show `view` (no edit came in while the open ran);
    /// when it does, the view is drawn in the same step. False: open again.
    func handOver(to view: HealthEngine.CloudView, if decide: @escaping @MainActor () -> Bool) async -> Bool {
        await chain {
            guard decide() else { return false }
            await self.draw(view)
            return true
        }.value
    }

    /// What the session made of a cloud edit, onto the screen.
    func shown(_ outcome: EditOutcome, order: Int, of edit: RecordEdit) async -> ApplyResult {
        guard outcome.ok, let next = outcome.record, let nextErase = outcome.erase else {
            return .refused(message: outcome.message ?? "That could not be saved.", existingId: outcome.existingId)
        }
        if next == recordJSON { return .saved() }
        // The session has taken the edit: the choices follow it, once it is drawn (adversary R4).
        await draw(next, order: order, as: .cloudEdited(erase: nextErase), in: Self.clearsChoices(edit) ? UnitChoices() : nil)
        onEdit?()
        return .saved(healthRecords: outcome.healthRecords)
    }
}
