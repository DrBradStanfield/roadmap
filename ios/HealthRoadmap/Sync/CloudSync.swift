import Foundation
import Observation

/// Keeps the record in the user's Dropbox or Google Drive (US-25 AC11). It signs
/// in, opens the engine's cloud session, tells it when the app shows and hides,
/// and turns what the engine reports into a status the Sync screen draws. It
/// decides nothing about what is written: that is health-core's RecordSession,
/// run in the engine (ios/engine/cloud.ts). It also answers the engine's calls
/// for tokens and its news (`CloudPort`); the phone's file and the pending marker
/// are `PhoneFiles`, which the engine reads and writes on its own queue. Its
/// connection is one state, `CloudConnection`, changed only by its transition (AC11m).
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
        case disconnecting
    }

    /// What a Disconnect did, for the screen that asked.
    enum DisconnectOutcome: Equatable {
        /// On the phone. `copied`: the cloud record was merged down first.
        case done(copied: Bool)
        /// An erase or another Disconnect is running: nothing changed.
        case refused
        /// The provider file could not be removed: still connected, nothing else touched.
        case failed
        /// A switch's copy-down could not reach the cloud with a session open, or the engine
        /// threw: still connected, nothing removed (US-25 AC11n). A plain Disconnect never stops.
        case unreachable
    }

    /// What a switch did (US-25 AC11n).
    enum SwitchOutcome {
        /// No sign-in started: the Disconnect was refused, failed or stopped (`unreachable`).
        case stayed(DisconnectOutcome)
        /// Disconnected, then connected (nil), or the connect threw this.
        case moved(Error?)
    }

    /// The one source for the provider, the status and the open session.
    private(set) var connection = CloudConnection.phone(attempt: 0)
    /// The connected cloud; nil when the record is the phone's file.
    var provider: CloudProvider? { connection.provider }
    var status: Status { CloudConnection.status(connection, pending: files.exists(files.pending)) }
    /// True once the cloud record is open and shown. A connect can succeed and
    /// the open still fail (offline, a provider error): onboarding waits for this (US-54 AC2).
    var recordOpen: Bool { connection.shownSession != nil }
    /// The connected account's email, which Sync shows; nil when the provider gave
    /// none. On the phone only (SyncFiles.email), never logged.
    private(set) var accountEmail: String?
    /// The cloud the record was last synced with, kept after Disconnect: the copy
    /// there stays, so the app never says the record never left the phone (review A3).
    private(set) var syncedBefore: CloudProvider?
    /// True while "Delete all my data" runs, from the tap until its words show: a reader of
    /// `DataEraser.phase`, wired only by `waitsFor`, read at each decision and never kept.
    /// Connect and Disconnect wait (US-25 AC16e): either would swap the session the erase
    /// writes under (review R2), and a first connect would lift a half-erased record.
    private(set) var eraseRunning: @MainActor () -> Bool = { false }
    /// Connect and a switch refuse with these words while an erase runs (AC16e).
    private static let waitForErase = OAuthClient.Failure.refused("Wait for the erase to finish, then connect.")

    /// The one wiring of `eraseRunning`, called by DataEraser's init: it takes this CloudSync,
    /// so every eraser built on it is the one Connect and Disconnect wait for.
    func waitsFor(_ eraser: DataEraser) {
        eraseRunning = { [weak eraser] in eraser?.erasing ?? false }
    }

    private let engine: HealthEngine
    private let store: RecordStore
    private let oauth: OAuthClient
    private let files: SyncFiles
    private let phone: PhoneFiles

    init(engine: HealthEngine, store: RecordStore, oauth: OAuthClient) {
        self.engine = engine
        self.store = store
        self.oauth = oauth
        files = SyncFiles(folder: store.file.deletingLastPathComponent())
        phone = PhoneFiles(record: store.file, pending: files.pending)
        let onFile = files.read(files.provider).flatMap(CloudProvider.init(rawValue:))
        // The provider file is the decision; without it, what a Disconnect or a failed
        // connect left behind goes now (AC11m).
        if onFile == nil { removeLeftovers() }
        syncedBefore = files.read(files.history).flatMap(CloudProvider.init(rawValue:))
        accountEmail = onFile == nil ? nil : files.read(files.email)
        send(.launched(onFile))
        // Queued, not waited for: the engine's queue runs it before any call made after this.
        engine.enqueue { [phone] in $0.attach(self, phone: phone) }
        store.onEdit = { [weak self] in _ = self?.send(.edited) }
    }

    /// At launch: open the cloud record, if a cloud is connected.
    func start() async {
        await run(send(.openStarted))
    }

    /// Sign in and connect. On a first connect the phone's record is merged up
    /// into the cloud's. Signing in again as a different account is refused:
    /// it would merge one person's record into another's (review A6).
    func connect(_ provider: CloudProvider, authenticate: OAuthClient.Authenticate) async throws {
        #if DEBUG
        // A demo record never reaches anyone's cloud (DemoRecord).
        guard !DemoRecord.isOn else { throw OAuthClient.Failure.refused("A demo record never syncs.") }
        #endif
        guard !eraseRunning() else { throw Self.waitForErase }
        // Before the sign-in shows, so nobody goes through a consent only to be refused (review of PR 1329).
        try verdict(send(.signInStarted(provider)))
        let key = connection.signInKey
        let signedIn: OAuthClient.SignedIn
        do {
            signedIn = try await oauth.signIn(provider, authenticate: authenticate)
        } catch {
            // A sign-in that failed after a Disconnect is voided too: its error would show for
            // a sign-in the person walked away from. Otherwise the error stands unchanged.
            if connection.signInKey != key { throw OAuthClient.Failure.cancelled }
            throw error
        }
        // A sign-in begun before the erase may finish during it (Codex re-check R2).
        guard !eraseRunning() else { throw Self.waitForErase }
        let known = files.read(files.account)
        let effects = send(.signInReturned(key: key, provider: provider, otherAccount: known != nil && known != signedIn.account))
        try verdict(effects)
        do {
            try keep(signedIn)
        } catch {
            await run(send(.keepFailed(attempt: connection.attempt, SyncProblem(error), onFile: files.exists(files.provider))))
            throw error
        }
        await run(effects)
    }

    /// The app came to the foreground: re-read, or try again to open.
    func foreground() async {
        if recordOpen {
            try? await engine.cloudVisible()
        } else {
            await run(send(.openStarted))
        }
    }

    /// The app is leaving the screen: stop re-reading, and save what waits.
    func background() async {
        guard recordOpen else { return }
        try? await engine.cloudHidden()
        _ = try? await engine.cloudFlush()
    }

    /// "Sync now": save what waits and read the cloud again.
    func syncNow() async {
        guard let session = connection.shownSession else { return await run(send(.openStarted)) }
        send(.syncStarted)
        do {
            let saved = try await engine.cloudFlush()
            _ = try await engine.cloudRefresh()
            send(.syncEnded(session: session, saved ? .done : .waiting, at: .now))
        } catch {
            send(.syncEnded(session: session, .failed(SyncProblem(error)), at: .now))
        }
    }

    /// "Delete all my data" through the open session (US-25 AC16; the erase is the
    /// engine's RecordSession.deleteAllData). Nil when no session is open: the phone
    /// then cannot read the cloud record, so it cannot list what it erases, and
    /// refuses as the web does (US-09 AC23).
    func erase(chatHistory: String?, keepChat: @escaping @Sendable (String) -> Bool) async throws -> HealthEngine.CloudErase? {
        guard let session = connection.shownSession else { return nil }
        send(.syncStarted)
        let result: HealthEngine.CloudErase
        do {
            result = try await engine.cloudErase(historyJSON: chatHistory, now: .now, keepChat: keepChat)
        } catch {
            send(.eraseEnded(session: session, .failed(SyncProblem(error)), at: .now))
            throw error
        }
        // "Delete all my data" takes the account's email too; the connection stays.
        if result.erased { forgetEmail() }
        // A Disconnect or reopen during the await owns the screen now (review F7).
        guard connection.shownSession == session else { return result }
        let shown = result.erased ? result.view.map { store.showErased($0) } : nil
        send(.eraseEnded(session: session, result.success ? .done : .failed(SyncProblem(kind: .unreachable)), at: .now))
        // Done once the screen shows the erased record.
        await shown?.value
        return result
    }

    /// Back to the phone: true unless the cloud could not be read for the copy down, or
    /// the Disconnect was refused or failed (`disconnectOutcome`).
    @discardableResult
    func disconnect() async -> Bool {
        if case .done(let copied) = await disconnectOutcome() { return copied }
        return false
    }

    /// The cloud record is merged down onto the phone first, then the provider file goes:
    /// it is the decision a relaunch reads (owner, 2026-11-12). Only once it is gone do the
    /// tokens and the other files go; what fails there, the next launch removes. The cloud
    /// file stays where it is. `done(copied: false)`: the cloud could not be read for the
    /// copy; the phone keeps what it already held.
    /// `forSwitch` (US-25 AC11n, owner D1 a): an unreachable copy-down with a session open, or an
    /// engine throw, stops it as connected as before (`unreachable`); never with no session
    /// ('none'). It also skips the wait for the phone's draw, so the caller's connect follows
    /// with no await between them.
    func disconnectOutcome(forSwitch: Bool = false) async -> DisconnectOutcome {
        guard provider != nil else { return .done(copied: true) }
        guard !eraseRunning(), send(.disconnectStarted).isEmpty, case .closing(let closing) = connection else { return .refused }
        let closed = try? await engine.cloudClose(copyDown: true)
        // Each step after an await checks this Disconnect still owns the connection (Codex C1).
        guard connection.attempt == closing.attempt else { return .refused }
        if forSwitch, closed == nil || closed == .unreachable {
            await stayConnected(closing.attempt)
            return .unreachable
        }
        guard removeProviderFile() else {
            await stayConnected(closing.attempt)
            return .failed
        }
        signOutAll()
        forgetEmail()
        files.remove(files.pending)
        let shown = store.showPhone()
        send(.disconnectEnded(attempt: closing.attempt))
        if !forSwitch { await shown.value }
        return .done(copied: closed == .copied)
    }

    /// One step from the connected cloud to `provider` (US-25 AC11n): Disconnect, then connect,
    /// with no await between the Disconnect's end and connect's first step, so no erase or other
    /// connect starts between them. Throws only the erase refusal, before anything changes.
    func switchTo(_ provider: CloudProvider, authenticate: OAuthClient.Authenticate) async throws -> SwitchOutcome {
        guard !eraseRunning() else { throw Self.waitForErase }
        // No cloud to switch from: one tapped during a switch's own sign-in.
        guard self.provider != nil else { return .stayed(.refused) }
        let closed = await disconnectOutcome(forSwitch: true)
        guard case .done = closed else { return .stayed(closed) }
        do {
            try await connect(provider, authenticate: authenticate)
            return .moved(nil)
        } catch {
            return .moved(error)
        }
    }

    // MARK: The connection

    /// The one way the connection changes. The store's pending marker and account follow it.
    @discardableResult
    private func send(_ event: CloudConnection.Event) -> [CloudConnection.Effect] {
        let step = CloudConnection.transition(connection, event)
        if step.next != connection { connection = step.next }
        linkStore()
        return step.effects
    }

    /// Connected, edits the phone takes are marked pending for the next open; the record's
    /// source for Apple Health's erase gate (US-72 AC10) is the provider and the account,
    /// so another account on the same provider is a new source.
    private func linkStore() {
        store.marksPending = provider == nil ? nil : phone
        let source = provider.map { provider in provider.rawValue + (files.read(files.account).map { ":" + $0 } ?? "") }
        if store.cloudAccount != source { store.cloudAccount = source }
    }

    /// Throws for a refused or dropped sign-in.
    private func verdict(_ effects: [CloudConnection.Effect]) throws {
        for effect in effects {
            if case .refuse(let words) = effect { throw OAuthClient.Failure.refused(words) }
            if effect == .cancel { throw OAuthClient.Failure.cancelled }
        }
    }

    /// Runs a step's effects in order: those that need no wait now, then the rest.
    private func run(_ effects: [CloudConnection.Effect]) async {
        for effect in runNow(effects) {
            // Each runs only while the connection is at the attempt that decided it (review R1).
            if case .open(let attempt) = effect, connection.attempt == attempt { await open() }
            if case .closeSession(let attempt) = effect, connection.attempt == attempt { _ = try? await engine.cloudClose(copyDown: false) }
        }
    }

    /// Runs the effects that need no wait; returns the open and the close, which do.
    private func runNow(_ effects: [CloudConnection.Effect]) -> [CloudConnection.Effect] {
        var later: [CloudConnection.Effect] = []
        for effect in effects {
            switch effect {
            case .showPhone: store.showPhone()
            case .showCloud(let view): store.showCloud(view)
            case .remember(let provider):
                syncedBefore = provider
                try? files.write(provider.rawValue, to: files.history)
            case .unkeep:
                signOutAll()
                forgetEmail()
            case .open, .closeSession: later.append(effect)
            // connect's own: it throws, or keeps, before the rest run.
            case .refuse, .cancel, .keep: break
            }
        }
        return later
    }

    /// Keeps a sign-in: the account file first, so a launch finding it without a provider file
    /// knows tokens may be left (`removeLeftovers`), then the tokens, and the provider file
    /// last, since it is what a relaunch reads. A throw leaves no provider file it wrote, so
    /// the step's `keepFailed` decides.
    private func keep(_ signedIn: OAuthClient.SignedIn) throws {
        try files.write(signedIn.account, to: files.account)
        try oauth.keep(signedIn)
        if let email = signedIn.email { try files.write(email, to: files.email) } else { files.remove(files.email) }
        try files.write(signedIn.provider.rawValue, to: files.provider)
        // One cloud at a time: any other cloud's token is a leftover (a delete the Keychain
        // refused, a reinstall). Best effort, and never the cloud just kept.
        for other in CloudProvider.allCases where other != signedIn.provider { oauth.signOut(other) }
        accountEmail = signedIn.email
        linkStore()
    }

    /// Runs the open the state names. While it opens, edits go to the phone's file, marked
    /// pending; if any landed, the transition opens again so the session merges them in,
    /// rather than showing a record without them.
    private func open() async {
        guard case .opening(let opening) = connection else { return }
        let view: HealthEngine.CloudView
        do {
            // A reopen merges the phone's file in, whatever its marker says: it holds
            // the edits that made this open go round again (adversary R1).
            view = try await engine.cloudOpen(provider: opening.provider, deviceId: store.deviceId,
                                              firstConnect: opening.firstConnect, mergePhone: opening.tries > 1)
        } catch {
            return await run(send(.openFailed(attempt: opening.attempt, SyncProblem(error))))
        }
        // Decided as a step in the store's line: every edit asked for before it has
        // landed on the phone's file and been counted (US-09 AC4, adversary R2). The
        // session is shown in the same turn as what it held; news after that turn is its own.
        var later: [CloudConnection.Effect] = []
        _ = await store.handOver(to: view) { [weak self] in
            guard let self else { return false }
            later = self.runNow(self.send(.opened(attempt: opening.attempt, session: view.session, at: .now)))
            return self.connection.shownSession == view.session
        }
        await run(later)
    }

    /// A Disconnect that did not happen: connected as before, as a relaunch reads it, and the
    /// record opens again (the engine closed its session already).
    private func stayConnected(_ attempt: Int) async {
        await run(send(.closeFailed(attempt: attempt)))
        await run(send(.openStarted))
    }

    /// The provider file goes, tried once more if it stays. True once it is gone.
    private func removeProviderFile() -> Bool {
        for _ in 0..<2 {
            files.remove(files.provider)
            if !files.exists(files.provider) { return true }
        }
        return false
    }

    /// With no provider file, the sync files are leftovers of a Disconnect or a connect that
    /// failed partway, removed at launch so a relaunch reads one state. An account file marks
    /// tokens that may be left too: a connect writes it before the tokens, and it goes only
    /// once the Keychain has deleted them (`signOutAll`), so a launch retries from it (Codex C2).
    private func removeLeftovers() {
        if files.exists(files.account) { signOutAll() }
        files.remove(files.email)
        files.remove(files.pending)
    }

    /// Deletes every cloud's tokens, not only the one disconnected: one cloud is connected at a
    /// time, so no other's should exist (round 2). The account file, the mark launch cleanup
    /// retries from, goes only once every delete worked.
    private func signOutAll() {
        if CloudProvider.allCases.map(oauth.signOut).allSatisfy({ $0 }) { files.remove(files.account) }
    }

    private func forgetEmail() {
        files.remove(files.email)
        accountEmail = nil
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
        _ = runNow(send(.news(session: session, news, at: .now)))
    }
}
