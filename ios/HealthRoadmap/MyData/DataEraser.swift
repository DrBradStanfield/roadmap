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
    }

    private(set) var erasing = false
    /// Counts erases the person has seen the words for: each one starts the new-user
    /// questions again (US-54 AC7, RootView).
    private(set) var startsOver = 0
    /// An erase is done but its words are still on screen: nothing else may cover them.
    private(set) var awaitingDismissal = false

    private let engine: HealthEngine
    private let store: RecordStore
    private let sync: CloudSync
    private let chat: ChatHistoryStore
    private let reminders: ReminderScheduler?
    private let health: AppleHealthSync?

    init(engine: HealthEngine, store: RecordStore, sync: CloudSync, chat: ChatHistoryStore, reminders: ReminderScheduler?, health: AppleHealthSync?) {
        self.engine = engine
        self.store = store
        self.sync = sync
        self.chat = chat
        self.reminders = reminders
        self.health = health
    }

    /// The erase's words were dismissed: the questions start again on the empty record.
    func erasedAndSeen() {
        awaitingDismissal = false
        startsOver += 1
    }

    /// Whether the confirmation names Apple Health.
    var appleHealthConnected: Bool { health?.connected ?? false }

    func eraseAll() async -> Outcome {
        guard !erasing else { return .refused("An erase is already running.") }
        erasing = true
        defer { erasing = false }
        let units = store.myData?.unitSystem
        let outcome = if let provider = sync.provider { await eraseInCloud(provider) } else { await eraseOnPhone() }
        if case .refused = outcome { return outcome }
        awaitingDismissal = true
        // After the record: an erase refused there must change nothing, and Health's
        // copies of typed values are only copies (D6).
        let healthErased = await health?.eraseOwnSamples() ?? true
        await keepUnits(units)
        await reminders?.refresh()
        guard !healthErased else { return outcome }
        switch outcome {
        case .erased(let text): return .erased(text + EraseText.healthNotErased)
        case .notSent(let text): return .notSent(text + EraseText.healthNotErased)
        case .refused: return outcome
        }
    }

    private func eraseOnPhone() async -> Outcome {
        guard store.problem == nil, let record = try? store.phoneText() else { return .refused(EraseText.unreadable) }
        let (history, chatReadable) = chatText()
        let result: HealthEngine.PhoneErase
        do {
            result = try await engine.eraseOnPhone(recordJSON: record, historyJSON: history, now: .now, deviceId: store.deviceId)
        } catch {
            return .refused(EraseText.unreadable)
        }
        let chatErased = chatReadable && result.chatErased && chat.keepErased(result.chatHistory)
        do {
            try await store.showErased(result.record)
        } catch {
            return .refused(EraseText.notWritten(error.localizedDescription, chatErased: chatErased))
        }
        return .erased(EraseText.done(provider: nil, chatErased: chatErased, cloudChat: nil))
    }

    private func eraseInCloud(_ provider: CloudProvider) async -> Outcome {
        let (history, chatReadable) = chatText()
        // Written on the engine's queue, inside the erase; read here once it is over.
        let written = OSAllocatedUnfairLock(initialState: false)
        let writeErased = chat.writeErased
        var chatWritten: Bool { written.withLock { $0 } }
        defer { if chatWritten { chat.refresh() } }
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
            ? .erased(EraseText.done(provider: provider, chatErased: chatErased, cloudChat: result.cloudChat))
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
