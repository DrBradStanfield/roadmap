import Foundation
import Observation

/// Keeps the record in the user's Dropbox or Google Drive (US-25 AC11). It signs
/// in, opens the engine's cloud session, tells it when the app shows and hides,
/// and turns what the engine reports into a status the Sync screen draws. It
/// decides nothing about what is written: that is health-core's RecordSession,
/// run in the engine (ios/engine/cloud.ts). It also answers the engine's calls
/// for tokens and its news (`CloudPort`); the phone's file and the pending marker
/// are `PhoneFiles`, which the engine reads and writes on its own queue.
@MainActor
@Observable
final class CloudSync: CloudPort {
    enum Status: Equatable {
        /// Not connected: the record is the phone's file.
        case onPhone
        case connecting
        case synced(Date)
        case saving
        case problem(SyncProblem)
    }

    /// The connected cloud; nil when the record is the phone's file.
    private(set) var provider: CloudProvider?
    private(set) var status = Status.onPhone
    /// The connected account's email, which Sync shows; nil when the provider gave
    /// none. On the phone only (SyncFiles.email), never logged.
    private(set) var accountEmail: String?
    /// The cloud the record was last synced with, kept after Disconnect: the copy
    /// there stays, so the app never says the record never left the phone (review A3).
    private(set) var syncedBefore: CloudProvider?
    /// True while "Delete all my data" runs on the open session. Connect and
    /// Disconnect wait: either would swap the session the erase writes under, and
    /// the screen and the phone's file would keep the old record (review R2).
    private(set) var erasing = false

    private let engine: HealthEngine
    private let store: RecordStore
    private let oauth: OAuthClient
    private let files: SyncFiles
    private let phone: PhoneFiles
    /// The engine session the app shows and sends edits to; nil when none is
    /// open. Everything that talks to the session checks this, never the store,
    /// and news from any other session is dropped (review F2, F4).
    private var shownSession: Int?
    private var sessionOpen: Bool { shownSession != nil }
    /// True once the cloud record is open and shown. A connect can succeed and
    /// the open still fail (offline, a provider error): onboarding waits for this (US-54 AC2).
    var recordOpen: Bool { sessionOpen }
    /// Moves on every Disconnect. An open that finishes under an older one is
    /// closed, not shown: Disconnect wins (review R5).
    private var generation = 0
    /// The generation an open is under way for; nil when none is.
    private var openingFor: Int?
    /// Edits the phone took while an open was under way (review A5).
    private var editsWhileOpening = 0
    /// News a session sent before the handover showed it: the newest record each
    /// session brought in, and its last failure, shown once that session is (adversary R2, R4).
    private var heldNews: [Int: HealthEngine.CloudView] = [:]
    private var heldFailures: [Int: SyncProblem] = [:]

    init(engine: HealthEngine, store: RecordStore, oauth: OAuthClient) {
        self.engine = engine
        self.store = store
        self.oauth = oauth
        files = SyncFiles(folder: store.file.deletingLastPathComponent())
        phone = PhoneFiles(record: store.file, pending: files.pending)
        provider = files.read(files.provider).flatMap(CloudProvider.init(rawValue:))
        if provider != nil { store.marksPending = phone }
        syncedBefore = files.read(files.history).flatMap(CloudProvider.init(rawValue:))
        accountEmail = provider == nil ? nil : files.read(files.email)
        // Queued, not waited for: the engine's queue runs it before any call made after this.
        engine.enqueue { [phone] in $0.attach(self, phone: phone) }
        store.onEdit = { [weak self] in self?.edited() }
        if provider != nil { status = .connecting }
    }

    /// At launch: open the cloud record, if a cloud is connected.
    func start() async {
        if provider != nil { await open(firstConnect: false) }
    }

    /// Sign in and connect. On a first connect the phone's record is merged up
    /// into the cloud's. Signing in again as a different account is refused:
    /// it would merge one person's record into another's (review A6).
    func connect(_ provider: CloudProvider, authenticate: OAuthClient.Authenticate) async throws {
        guard !erasing else { throw OAuthClient.Failure.refused("Wait for the erase to finish, then connect.") }
        let signedIn = try await oauth.signIn(provider, authenticate: authenticate)
        // A sign-in begun before the erase may finish during it (Codex re-check R2).
        guard !erasing else { throw OAuthClient.Failure.refused("Wait for the erase to finish, then connect.") }
        if self.provider == provider, let known = files.read(files.account), known != signedIn.account {
            throw OAuthClient.Failure.refused("That is a different \(provider.label) account from the one this iPhone syncs with. To use it, disconnect first, then connect it.")
        }
        let first = self.provider != provider
        try oauth.keep(signedIn)
        try files.write(provider.rawValue, to: files.provider)
        try files.write(signedIn.account, to: files.account)
        if let email = signedIn.email { try files.write(email, to: files.email) } else { files.remove(files.email) }
        accountEmail = signedIn.email
        self.provider = provider
        store.marksPending = phone
        await open(firstConnect: first)
    }

    /// The app came to the foreground: re-read, or try again to open.
    func foreground() async {
        guard provider != nil else { return }
        if sessionOpen {
            try? await engine.cloudVisible()
        } else {
            await open(firstConnect: false)
        }
    }

    /// The app is leaving the screen: stop re-reading, and save what waits.
    func background() async {
        guard sessionOpen else { return }
        try? await engine.cloudHidden()
        _ = try? await engine.cloudFlush()
    }

    /// "Sync now": save what waits and read the cloud again.
    func syncNow() async {
        guard provider != nil else { return }
        guard let session = shownSession else { return await open(firstConnect: false) }
        status = .saving
        do {
            let saved = try await engine.cloudFlush()
            _ = try await engine.cloudRefresh()
            // A Disconnect or reopen during the awaits owns the status now (review F7).
            if saved, shownSession == session { status = settled() }
        } catch {
            if shownSession == session { status = .problem(SyncProblem(error)) }
        }
    }

    /// "Delete all my data" through the open session (US-25 AC16; the erase is the
    /// engine's RecordSession.deleteAllData). Nil when no session is open: the phone
    /// then cannot read the cloud record, so it cannot list what it erases, and
    /// refuses as the web does (US-09 AC23).
    func erase(chatHistory: String?, keepChat: @escaping @Sendable (String) -> Bool) async throws -> HealthEngine.CloudErase? {
        guard let session = shownSession else { return nil }
        erasing = true
        defer { erasing = false }
        status = .saving
        let result: HealthEngine.CloudErase
        do {
            result = try await engine.cloudErase(historyJSON: chatHistory, now: .now, keepChat: keepChat)
        } catch {
            if shownSession == session { status = .problem(SyncProblem(error)) }
            throw error
        }
        // "Delete all my data" takes the account's email too; the connection stays.
        if result.erased { forgetEmail() }
        // A Disconnect or reopen during the await owns the screen now (review F7).
        guard shownSession == session else { return result }
        let shown = result.erased ? result.view.map { store.showErased($0) } : nil
        if result.success {
            status = .synced(.now)
        } else if status == .saving {
            status = .problem(SyncProblem(kind: .unreachable))
        }
        // Done once the screen shows the erased record.
        await shown?.value
        return result
    }

    /// Back to the phone: the cloud record is merged down onto the phone first,
    /// then the tokens go. The cloud file stays where it is. False when the cloud
    /// could not be read for the copy; the phone keeps what it already held.
    @discardableResult
    func disconnect() async -> Bool {
        guard let provider else { return true }
        guard !erasing else { return false }
        generation += 1
        shownSession = nil
        self.provider = nil
        store.marksPending = nil
        let copied = (try? await engine.cloudClose(copyDown: true)) ?? false
        oauth.signOut(provider)
        files.remove(files.provider)
        files.remove(files.account)
        forgetEmail()
        files.remove(files.pending)
        let shown = store.showPhone()
        status = .onPhone
        await shown.value
        return copied
    }

    /// Open (or reopen) the cloud session. While it opens, edits go to the
    /// phone's file, marked pending; if any landed, the open runs once more so
    /// the session merges them in, rather than showing a record without them.
    private func open(firstConnect: Bool) async {
        guard let provider, openingFor != generation else { return }
        let mine = generation
        openingFor = mine
        defer { if openingFor == mine { openingFor = nil } }
        // The phone's file holds every edit (write-ahead), so the screen falls back
        // to it while the session is closed, and edits made meanwhile wait there.
        if sessionOpen {
            shownSession = nil
            store.showPhone()
        }
        status = .connecting
        heldNews = [:]
        heldFailures = [:]
        var first = firstConnect
        for attempt in 0..<3 {
            editsWhileOpening = 0
            do {
                // A reopen merges the phone's file in, whatever its marker says: it holds
                // the edits that made this open go round again (adversary R1).
                let view = try await engine.cloudOpen(provider: provider, deviceId: store.deviceId, firstConnect: first, mergePhone: attempt > 0)
                // Disconnected meanwhile: the Disconnect closed what this open made.
                guard mine == generation else { return }
                first = false
                // Decided as a step in the store's line: every edit asked for before it has
                // landed on the phone's file and been counted (US-09 AC4, adversary R2).
                // The status is set in the same turn the session is shown, from what it held;
                // news after that turn is its own and is never overwritten here (R2).
                let shown = await store.handOver(to: view) { [weak self] in
                    guard let self, mine == self.generation, self.editsWhileOpening == 0 else { return false }
                    self.shownSession = view.session
                    if let held = self.heldNews[view.session] { self.store.showCloud(held) }
                    self.status = self.heldFailures[view.session].map { .problem($0) } ?? self.settled()
                    self.heldNews = [:]
                    self.heldFailures = [:]
                    self.syncedBefore = provider
                    try? self.files.write(provider.rawValue, to: self.files.history)
                    return true
                }
                guard mine == generation else { return }
                guard shown else { continue }
                return
            } catch {
                guard mine == generation else { return }
                status = .problem(SyncProblem(error))
                return
            }
        }
        // Edits kept arriving: close the session the last try opened, so nothing
        // polls behind the phone's record, and try again on the next foreground (F3).
        _ = try? await engine.cloudClose(copyDown: false)
        guard mine == generation else { return }
        status = .problem(SyncProblem(kind: .busy))
    }

    private func forgetEmail() {
        files.remove(files.email)
        accountEmail = nil
    }

    /// The one rule for "Synced": nothing waits on the phone, the pending marker
    /// clear. The marker is set before every edit is taken and cleared by the
    /// session only once a save has landed, so it is the session's unsaved state
    /// too (re-check R3). While it is set the app says "Saving…".
    private func settled() -> Status {
        files.exists(files.pending) ? .saving : .synced(.now)
    }

    private func edited() {
        if sessionOpen {
            status = .saving
        } else if provider != nil {
            // Connected, but no session is open: this edit waits on the phone, marked
            // pending by the engine step that wrote it (RecordStore.marksPending). An open
            // under way counts it and opens again (it waits for edits to land first).
            editsWhileOpening += 1
        }
    }

    // MARK: CloudPort

    func accessToken(provider: String, force: Bool) async -> TokenAnswer {
        guard let cloud = CloudProvider(rawValue: provider) else { return .failed("Unknown cloud.", signIn: true) }
        do {
            return .token(try await oauth.accessToken(cloud, force: force))
        } catch OAuthClient.Failure.signInAgain {
            return .failed("\(cloud.label) needs you to sign in again.", signIn: true)
        } catch {
            return .failed(error.localizedDescription, signIn: false)
        }
    }

    func notify(_ news: HealthEngine.CloudNews, session: Int) {
        guard session == shownSession else {
            // A session still being handed over: keep the record it brought in, and a
            // failure it met, for when it shows.
            guard openingFor != nil else { return }
            switch news {
            case .failed(let problem): heldFailures[session] = problem
            case .saved, .synced: heldFailures[session] = nil
            case .changed(let view): heldNews[session] = view
            case .saving, .other: break
            }
            return
        }
        switch news {
        case .saving: status = .saving
        // A write landed, but the save may still verify or go round again:
        // "Synced" waits for the marker to clear (the 'synced' event).
        case .saved: status = settled()
        // The pending marker cleared, or a re-read worked with nothing waiting.
        case .synced: status = settled()
        case .failed(let problem): status = .problem(problem)
        case .changed(let view): store.showCloud(view)
        case .other: break
        }
    }
}
