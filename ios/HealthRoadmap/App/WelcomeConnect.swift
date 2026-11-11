/// The welcome screen's cloud connect (US-54 AC2, AC2b). The screen keeps no copy of
/// how an open went: it reads its phase from CloudSync each time, so a relaunch shows
/// the launch open still running, and Cancel never leaves an old failure behind.
/// Residual: WelcomeView's wiring (its onChange, openRecord on showSheetAndOpen, the empty
/// connect callback) has no unit test: the project has no view-inspection library and the
/// UI tests have no fake cloud (state lead M7).
enum WelcomeConnect {
    enum Phase: Equatable {
        /// No cloud connected: the person picks one.
        case choosing
        /// A cloud is connected and its record is not open yet.
        case opening
        /// The last open failed.
        case failed(SyncProblem)
        /// The cloud record is open: the screen can go on.
        case opened
    }

    /// No spinner without an open behind it: every tap that can show `opening` also
    /// starts an open (`Decision.showSheetAndOpen`, `.open`), and CloudSync's open is
    /// single-flight, so one already running is joined, not doubled.
    static func phase(provider: CloudProvider?, status: CloudSync.Status, recordOpen: Bool) -> Phase {
        if recordOpen { return .opened }
        guard provider != nil else { return .choosing }
        // No default arm: a new status does not compile until its phase is decided.
        switch status {
        // In flight after start(), connect or foreground began an open. Also set at
        // init, before start() runs, with nothing running: the taps start one.
        case .connecting: return .opening
        case .problem(let problem): return .failed(problem)
        // Not reached with a cloud and no open record today (connect and a reopen set
        // .connecting in the same turn; saving and synced need an open session). No
        // open is implied, so the taps start one.
        case .onPhone, .synced, .saving: return .opening
        }
    }

    /// The Connect buttons hide while a record opens: a second cloud chosen mid-open would
    /// set the provider while the first cloud's open hands over (review, PR 1281).
    static func showsConnect(_ phase: Phase) -> Bool {
        switch phase {
        case .choosing, .failed: true
        case .opening, .opened: false
        }
    }

    enum Event {
        case getStarted
        /// "I already use Health Roadmap".
        case existing
        case tryAgain
        case phaseChanged
    }

    enum Decision: Equatable {
        /// The questions, on the phone's record: no cloud is connected.
        case start
        /// The cloud record is open: close the sheet and go on.
        case goOn
        case showSheet
        case showSheetAndOpen
        case open
        case nothing
    }

    /// Going on closes the sheet, so it happens once: a phase change goes on only while
    /// the sheet shows, and a tap only when the record is already open.
    static func decide(_ event: Event, phase: Phase, sheetShown: Bool) -> Decision {
        switch (event, phase) {
        case (.getStarted, .choosing): .start
        case (.existing, .choosing): .showSheet
        case (.getStarted, .opened), (.existing, .opened): .goOn
        case (.getStarted, _), (.existing, _): .showSheetAndOpen
        case (.tryAgain, .opening), (.tryAgain, .failed): .open
        case (.tryAgain, _): .nothing
        case (.phaseChanged, .opened): sheetShown ? .goOn : .nothing
        case (.phaseChanged, _): .nothing
        }
    }
}
