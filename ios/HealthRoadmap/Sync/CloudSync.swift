import Foundation
import Observation

/// Keeps the record in the user's Dropbox or Google Drive (US-25 AC11). It signs
/// in, opens the engine's cloud session, tells it when the app shows and hides,
/// and turns what the engine reports into a status the Sync screen draws. It
/// decides nothing about what is written: that is health-core's RecordSession,
/// run in the engine (ios/engine/cloud.ts). It also answers the engine's calls
/// for tokens, the phone's file and the pending marker (`CloudPort`).
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
    /// The cloud the record was last synced with, kept after Disconnect: the copy
    /// there stays, so the app never says the record never left the phone (review A3).
    private(set) var syncedBefore: CloudProvider?

    private let engine: HealthEngine
    private let store: RecordStore
    private let oauth: OAuthClient
    private let files: SyncFiles
    /// True only while the engine holds an open session and the store sends it
    /// edits. Everything that talks to the session checks this, never the store.
    private var sessionOpen = false
    /// Moves on every Disconnect. An open that finishes under an older one is
    /// closed, not shown: Disconnect wins (review R5).
    private var generation = 0
    /// The generation an open is under way for; nil when none is.
    private var openingFor: Int?
    /// Edits the phone took while an open was under way (review A5).
    private var editsWhileOpening = 0

    init(engine: HealthEngine, store: RecordStore, oauth: OAuthClient) {
        self.engine = engine
        self.store = store
        self.oauth = oauth
        files = SyncFiles(folder: store.file.deletingLastPathComponent())
        provider = files.read(files.provider).flatMap(CloudProvider.init(rawValue:))
        syncedBefore = files.read(files.history).flatMap(CloudProvider.init(rawValue:))
        engine.natives.cloud = self
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
        let signedIn = try await oauth.signIn(provider, authenticate: authenticate)
        if self.provider == provider, let known = files.read(files.account), known != signedIn.account {
            throw OAuthClient.Failure.refused("That is a different \(provider.label) account from the one this iPhone syncs with. To use it, disconnect first, then connect it.")
        }
        let first = self.provider != provider
        try oauth.keep(signedIn)
        try files.write(provider.rawValue, to: files.provider)
        try files.write(signedIn.account, to: files.account)
        self.provider = provider
        await open(firstConnect: first)
    }

    /// The app came to the foreground: re-read, or try again to open.
    func foreground() async {
        guard provider != nil else { return }
        if sessionOpen {
            try? engine.cloudVisible()
        } else {
            await open(firstConnect: false)
        }
    }

    /// The app is leaving the screen: stop re-reading, and save what waits.
    func background() async {
        guard sessionOpen else { return }
        try? engine.cloudHidden()
        _ = try? await engine.cloudFlush()
    }

    /// "Sync now": save what waits and read the cloud again.
    func syncNow() async {
        guard provider != nil else { return }
        guard sessionOpen else { return await open(firstConnect: false) }
        status = .saving
        do {
            let saved = try await engine.cloudFlush()
            _ = try await engine.cloudRefresh()
            if saved { status = .synced(.now) }
        } catch {
            status = .problem(SyncProblem(error))
        }
    }

    /// Back to the phone: the cloud record is merged down onto the phone first,
    /// then the tokens go. The cloud file stays where it is. False when the cloud
    /// could not be read for the copy; the phone keeps what it already held.
    @discardableResult
    func disconnect() async -> Bool {
        guard let provider else { return true }
        generation += 1
        sessionOpen = false
        self.provider = nil
        let copied = (try? await engine.cloudClose(copyDown: true)) ?? false
        oauth.signOut(provider)
        files.remove(files.provider)
        files.remove(files.account)
        files.remove(files.pending)
        store.showPhone()
        status = .onPhone
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
            sessionOpen = false
            store.showPhone()
        }
        status = .connecting
        var first = firstConnect
        for _ in 0..<3 {
            editsWhileOpening = 0
            do {
                let view = try await engine.cloudOpen(provider: provider, deviceId: store.deviceId, firstConnect: first)
                guard mine == generation else {
                    // Disconnected meanwhile: close what this open made, show nothing.
                    _ = try? await engine.cloudClose(copyDown: false)
                    return
                }
                first = false
                if editsWhileOpening > 0 { continue }
                store.showCloud(view)
                sessionOpen = true
                status = .synced(.now)
                syncedBefore = provider
                try? files.write(provider.rawValue, to: files.history)
                return
            } catch {
                guard mine == generation else { return }
                status = .problem(SyncProblem(error))
                return
            }
        }
        // Edits kept arriving: stay on the phone; the next foreground opens again.
        status = .problem(SyncProblem(kind: .unreachable))
    }

    private func edited() {
        if sessionOpen {
            status = .saving
        } else if provider != nil {
            // Connected, but no session is open: this edit waits on the phone.
            _ = pending("set")
            if openingFor != nil { editsWhileOpening += 1 }
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

    func phoneRead() throws -> String? {
        try store.phoneText()
    }

    func phoneWrite(_ text: String) throws {
        try store.writePhone(text)
    }

    func phoneRemove() {
        store.removePhone()
    }

    func pending(_ op: String) -> Bool {
        switch op {
        case "set": try? files.write("", to: files.pending)
        case "clear": files.remove(files.pending)
        default: break
        }
        return files.exists(files.pending)
    }

    func notify(_ event: String, _ payload: String) {
        switch event {
        case "saving": status = .saving
        case "saved": status = .synced(.now)
        // A re-read worked: a passing failure is over. Never over "Saving…".
        case "synced": if case .problem = status { status = .synced(.now) }
        case "failed": status = .problem(SyncProblem(json: payload))
        case "changed":
            if sessionOpen, let view = try? JSONDecoder().decode(HealthEngine.CloudView.self, from: Data(payload.utf8)) { store.showCloud(view) }
        default: break
        }
    }
}
