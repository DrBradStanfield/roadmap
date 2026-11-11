import Foundation
import Observation
import os

/// "Delete all my data" (US-25 AC16; US-11 on the iPhone). It decides which erase
/// runs and keeps the files and views around it in step; the erase itself is the
/// engine's (HealthEngine+Erase.swift):
/// - No cloud: the phone's file, by health-core's buildErasedFile.
/// - A cloud open: RecordSession.deleteAllData, through CloudSync. The cloud file
///   keeps the erase (a higher eraseEpoch), so other devices take it in.
/// - A cloud connected but not open: refused, as the web refuses an erase in its
///   on-device fallback. It cannot read the record, so it cannot list what it erases.
/// The web's order holds: the record is read first, and a refusal there changes
/// nothing; then the chat tombstones; then the record. Reminders follow the
/// record's erase epoch (ReminderScheduler), so a refresh after the erase ends them.
@MainActor
@Observable
final class DataEraser {
    enum Outcome: Equatable {
        /// Erased everywhere it was meant to be. The words to show.
        case erased(String)
        /// Erased on this iPhone; the cloud takes it on the next save.
        case notSent(String)
        /// Nothing was erased (or, rarely, only the chat history, and the words say so).
        case refused(String)

        var words: String {
            switch self { case .erased(let text), .notSent(let text), .refused(let text): text }
        }
    }

    /// One erase at a time, then its words until the person has seen them (US-25 AC16d). The
    /// words live here, not in the page: `done` shows them on the Delete page; `held` once
    /// the Settings sheet has closed on them, where RootView shows them.
    enum Phase: Equatable { case idle, erasing, done(Outcome), held(Outcome) }
    enum Event { case started, finished(Outcome), settingsClosed, seen }

    static func transition(_ phase: Phase, _ event: Event) -> Phase {
        switch (phase, event) {
        // Unseen erase words are never dropped by a second erase; a refusal's may be.
        case (.idle, .started), (.done(.refused), .started), (.held(.refused), .started): .erasing
        case (.erasing, .finished(let outcome)): .done(outcome)
        case (.done(let outcome), .settingsClosed): .held(outcome)
        case (.done, .seen), (.held, .seen): .idle
        default: phase
        }
    }

    private(set) var phase = Phase.idle
    /// Counts erases the person has seen the words for: each one starts the new-user
    /// questions again (US-54 AC7, RootView).
    private(set) var startsOver = 0
    /// Counts the times `holdsRemoteErases` turned false: RootView looks at the record again
    /// then, so an erase from elsewhere that landed meanwhile is not lost.
    private(set) var holdLifts = 0

    var erasing: Bool { phase == .erasing }
    /// The finished erase's words, until they are seen.
    var outcome: Outcome? {
        switch phase {
        case .done(let outcome), .held(let outcome): outcome
        case .idle, .erasing: nil
        }
    }
    /// The words the Settings sheet closed on, for RootView to show.
    var held: Outcome? {
        if case .held(let outcome) = phase { outcome } else { nil }
    }
    /// An erase is done but its words are not yet seen: nothing else may cover them.
    /// A refusal changed nothing, so it holds nothing back.
    var awaitingDismissal: Bool {
        switch outcome {
        case .erased, .notSent: true
        case .refused, nil: false
        }
    }
    /// While true, an erase from another device waits (RootView.recordChanged).
    var holdsRemoteErases: Bool { erasing || awaitingDismissal }

    private let store: RecordStore
    private let sync: CloudSync
    private let chat: ChatHistoryStore
    private let reminders: ReminderScheduler?
    private let health: AppleHealthSync?
    /// US-56's kept readings (AC2).
    private let live: LiveHealth?

    init(store: RecordStore, sync: CloudSync, chat: ChatHistoryStore, reminders: ReminderScheduler?, health: AppleHealthSync?, live: LiveHealth?) {
        self.store = store
        self.sync = sync
        self.chat = chat
        self.reminders = reminders
        self.health = health
        self.live = live
    }

    /// The erase's words were dismissed: after an erase the questions start again on the
    /// empty record; a refusal's words just go.
    func seen() {
        let erased = awaitingDismissal
        send(.seen)
        if erased { startsOver += 1 }
    }

    /// The Settings sheet closed: words still unseen go to RootView.
    func settingsClosed() { send(.settingsClosed) }

    private func send(_ event: Event) {
        let holding = holdsRemoteErases
        phase = Self.transition(phase, event)
        if holding, !holdsRemoteErases { holdLifts += 1 }
    }

    /// Whether the confirmation names Apple Health.
    var appleHealthConnected: Bool { health?.everConnected ?? false }

    @discardableResult
    func eraseAll() async -> Outcome {
        guard Self.transition(phase, .started) == .erasing, !erasing else {
            return .refused(erasing ? "An erase is already running." : "The last erase's words have not been seen yet.")
        }
        send(.started)
        let outcome = await erase()
        send(.finished(outcome))
        return outcome
    }

    private func erase() async -> Outcome {
        #if DEBUG
        await DemoRecord.slowErase()
        #endif
        let units = store.myData?.unitSystem
        let healthWasConnected = appleHealthConnected
        let outcome = if let provider = sync.provider { await eraseInCloud(provider) } else { await eraseOnPhone() }
        // Either way, the chat list is read again: its file may have been erased, even by a
        // refused erase that got as far as the chat step.
        await chat.refresh()
        if case .refused = outcome { return outcome }
        // After the record: an erase refused there must change nothing (Health stays connected,
        // its anchors where they were), and Health's copies of typed values are only copies (D6).
        // Then Health disconnects (US-72 AC10).
        let healthErased = await health?.erased(wasConnected: healthWasConnected) ?? true
        await live?.forget()
        await keepUnits(units)
        await reminders?.refresh()
        let after = (healthWasConnected ? EraseText.healthDisconnected : "") + (healthErased ? "" : EraseText.healthNotErased)
        switch outcome {
        case .erased(let text): return .erased(text + after)
        case .notSent(let text): return .notSent(text + after)
        case .refused: return outcome
        }
    }

    private func eraseOnPhone() async -> Outcome {
        let (history, chatReadable) = chatText()
        // One step in the store's line: an edit asked for meanwhile lands after the erase.
        // The chat file is written on the engine's queue, in line with the chat's own writes.
        let writeErased = chat.writeErased
        switch await store.erasePhone(historyJSON: history, keepChat: { tombstoned, engineErased in
            chatReadable && engineErased && writeErased(tombstoned)
        }) {
        case .unreadable: return .refused(EraseText.unreadable)
        case .notWritten(let why, let chatErased): return .refused(EraseText.notWritten(why, chatErased: chatErased))
        case .erased(let chatErased): return .erased(EraseText.done(provider: nil, chatErased: chatErased, cloudChat: nil))
        }
    }

    private func eraseInCloud(_ provider: CloudProvider) async -> Outcome {
        let (history, chatReadable) = chatText()
        // Written on the engine's queue, inside the erase; read here once it is over.
        let written = OSAllocatedUnfairLock(initialState: false)
        let writeErased = chat.writeErased
        var chatWritten: Bool { written.withLock { $0 } }
        let answer: HealthEngine.CloudErase?
        do {
            answer = try await sync.erase(chatHistory: history) { json in
                let ok = writeErased(json)
                written.withLock { $0 = ok }
                return ok
            }
        } catch {
            // The engine answered nothing, so whether the cloud chat went is unknown; a
            // rejection after its chat step does not happen (RecordSession refuses instead).
            return .refused(EraseText.failed(error.localizedDescription, chatErased: chatWritten, cloudChatErased: false, provider: provider))
        }
        guard let result = answer, result.erased else {
            // The engine refuses before the chat step, so neither chat file is erased here
            // but in a failure after it (re-check N2, L1), which the words then name.
            let cloudChatErased = answer?.cloudChatErased ?? false
            let words = chatWritten || cloudChatErased
                ? EraseText.failed(answer?.error ?? "", chatErased: chatWritten, cloudChatErased: cloudChatErased, provider: provider)
                : EraseText.refusal(answer?.error, provider: provider)
            return .refused(words)
        }
        let chatErased = chatReadable && result.chatErased
        return result.success
            ? .erased(EraseText.done(provider: provider, chatErased: chatErased, cloudChat: result.cloudChat, warning: result.warning))
            : .notSent(EraseText.notSent(provider: provider, chatErased: chatErased, cloudChat: result.cloudChat))
    }

    /// The chat file's text, and whether it could be read: one that is there but
    /// cannot be read is left alone, and the erase says so.
    private func chatText() -> (String?, Bool) {
        do {
            return (try chat.textForErase(), true)
        } catch {
            return (nil, false)
        }
    }

    /// The units are a setting, not a health value: the web keeps its unit
    /// preference through an erase, so the app puts the user's choice back.
    private func keepUnits(_ units: String?) async {
        guard let units, store.myData?.unitSystem != units else { return }
        _ = await store.apply(.units(units))
    }
}
