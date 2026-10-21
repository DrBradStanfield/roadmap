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

    private let engine: HealthEngine
    private let store: RecordStore
    private let oauth: OAuthClient
    /// Beside the record, so backups leave them out with it (D5): a phone
    /// restored from a backup starts unconnected, as its Keychain tokens stay behind.
    private let providerFile: URL
    private let pendingFile: URL
    /// An open under way: the launch and the first foreground must not open twice.
    private var opening = false

    init(engine: HealthEngine, store: RecordStore, oauth: OAuthClient) {
        self.engine = engine
        self.store = store
        self.oauth = oauth
        let folder = store.file.deletingLastPathComponent()
        providerFile = folder.appending(path: "sync-provider")
        pendingFile = folder.appending(path: "sync-pending")
        provider = (try? String(contentsOf: providerFile, encoding: .utf8)).flatMap(CloudProvider.init(rawValue:))
        engine.natives.cloud = self
        store.onEdit = { [weak self] in self?.edited() }
        if provider != nil { status = .connecting }
    }

    /// At launch: open the cloud record, if a cloud is connected.
    func start() async {
        if provider != nil { await open(firstConnect: false) }
    }

    /// Sign in and connect. The phone's record is merged up into the cloud's.
    func connect(_ provider: CloudProvider, authenticate: OAuthClient.Authenticate) async throws {
        try await oauth.signIn(provider, authenticate: authenticate)
        let first = self.provider != provider
        try Data(provider.rawValue.utf8).write(to: providerFile, options: .atomic)
        self.provider = provider
        await open(firstConnect: first)
    }

    /// The app came to the foreground: re-read, or try again to open.
    func foreground() async {
        guard provider != nil else { return }
        if store.cloudErase != nil {
            try? engine.cloudVisible()
        } else {
            await open(firstConnect: false)
        }
    }

    /// The app is leaving the screen: stop re-reading, and save what waits.
    func background() async {
        guard store.cloudErase != nil else { return }
        try? engine.cloudHidden()
        _ = try? await engine.cloudFlush()
    }

    /// "Sync now": save what waits and read the cloud again.
    func syncNow() async {
        guard provider != nil else { return }
        guard store.cloudErase != nil else { return await open(firstConnect: false) }
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
        let copied = (try? await engine.cloudClose(copyDown: true)) ?? false
        oauth.signOut(provider)
        try? FileManager.default.removeItem(at: providerFile)
        try? FileManager.default.removeItem(at: pendingFile)
        self.provider = nil
        store.showPhone()
        status = .onPhone
        return copied
    }

    private func open(firstConnect: Bool) async {
        guard let provider, !opening else { return }
        opening = true
        defer { opening = false }
        status = .connecting
        do {
            let view = try await engine.cloudOpen(provider: provider, deviceId: store.deviceId, firstConnect: firstConnect)
            store.showCloud(view)
            status = .synced(.now)
        } catch {
            // The phone's copy stays on screen and takes the edits, marked for the cloud.
            status = .problem(SyncProblem(error))
        }
    }

    private func edited() {
        if store.cloudErase != nil {
            status = .saving
        } else if provider != nil {
            // Connected, but the cloud could not be opened: this edit waits on the phone.
            _ = pending("set")
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
        case "set": try? Data().write(to: pendingFile, options: .atomic)
        case "clear": try? FileManager.default.removeItem(at: pendingFile)
        default: break
        }
        return FileManager.default.fileExists(atPath: pendingFile.path(percentEncoded: false))
    }

    func notify(_ event: String, _ payload: String) {
        switch event {
        case "saving": status = .saving
        case "saved": status = .synced(.now)
        case "failed": status = .problem(SyncProblem(json: payload))
        case "changed":
            if let view = try? JSONDecoder().decode(HealthEngine.CloudView.self, from: Data(payload.utf8)) { store.showCloud(view) }
        default: break
        }
    }
}
