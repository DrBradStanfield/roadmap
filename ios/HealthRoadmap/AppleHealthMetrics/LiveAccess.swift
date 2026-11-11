import Foundation

/// US-56: what the Apple Health cards know about access, as one named state (iPhone survey S4).
/// It replaced three properties side by side (`needsAccess`, `cards`, `hasRead`) that drifted:
/// an access reset cleared the cards but left "read", so a failed first read after a re-allow
/// drew the Open Settings row as if the person had tapped Don't Allow (AC5d). `LiveHealth`
/// changes it only through `transition`.
enum LiveAccess: Equatable {
    /// Health has not answered yet (the first check is pending, or it failed).
    case unknown
    /// Apple's sheet would still show for the types: the Turn On row (AC4, AC5).
    case needsAccess
    /// Access answered and nothing read since: a first read, or the one after an erase, has
    /// not landed. Nothing here promises a read is running; the next wake or refresh reads.
    case granted
    /// The last read that landed, each metric with a reading (AC6); empty after a "Don't
    /// Allow" or an empty Health, which iOS cannot tell apart (AC5b).
    case read([LiveMetric: LiveCard])

    enum Event: Equatable {
        /// The sheet check answered: true, the sheet is due; nil, the check failed.
        case checked(Bool?)
        case cardsRead([LiveMetric: LiveCard])
        /// A read that threw: a locked phone or a cancelled task (N1, AC13).
        case readFailed
        /// "Delete all my data" (AC2).
        case forgot
    }

    /// At launch: the kept cards count as access granted and read (AC15), else unknown.
    static func launch(_ kept: [LiveMetric: LiveCard]) -> LiveAccess {
        kept.isEmpty ? .unknown : .read(kept)
    }

    static func transition(_ s: LiveAccess, _ e: Event) -> LiveAccess {
        switch (s, e) {
        // A failed check keeps what was known, so the Turn On row never flashes (adversary R4).
        case (_, .checked(nil)): s
        // Access reset: the sheet is due again from any state (AC2).
        case (_, .checked(true)): .needsAccess
        case (.unknown, .checked(false)), (.needsAccess, .checked(false)): .granted
        case (.granted, .checked(false)), (.read, .checked(false)): s
        // A read lands only once access is granted. Ignored in unknown or needsAccess. Defensive:
        // unreachable while readOnce is the only sender of `checked`; the ticket guard is what
        // keeps a read from before an erase or a disconnect from landing. Kept so a later sender
        // cannot draw cards whose access was withdrawn.
        case (.granted, .cardsRead(let cards)), (.read, .cardsRead(let cards)): .read(cards)
        case (.unknown, .cardsRead), (.needsAccess, .cardsRead): s
        // Locked or cancelled: keep what was drawn, and never call it "read, empty" (N1, AC5d).
        case (_, .readFailed): s
        // The erase empties the cards; nothing shows until the next read (AC2).
        case (.read, .forgot): .granted
        case (_, .forgot): s
        }
    }

    /// The cards the last read drew; none in any other state.
    var cards: [LiveMetric: LiveCard] {
        if case .read(let cards) = self { cards } else { [:] }
    }
}
