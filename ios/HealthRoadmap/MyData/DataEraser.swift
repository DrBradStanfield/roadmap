import Foundation
import Observation

/// "Delete all my data" (US-25 AC13; US-11 on the iPhone). It decides which erase
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

    private let engine: HealthEngine
    private let store: RecordStore
    private let sync: CloudSync
    private let chat: ChatHistoryStore
    private let reminders: ReminderScheduler?

    init(engine: HealthEngine, store: RecordStore, sync: CloudSync, chat: ChatHistoryStore, reminders: ReminderScheduler?) {
        self.engine = engine
        self.store = store
        self.sync = sync
        self.chat = chat
        self.reminders = reminders
    }

    func eraseAll() async -> Outcome {
        guard !erasing else { return .refused("An erase is already running.") }
        erasing = true
        defer { erasing = false }
        let units = store.myData?.unitSystem
        let outcome = if let provider = sync.provider { await eraseInCloud(provider) } else { eraseOnPhone() }
        if case .refused = outcome { return outcome }
        // Apple Health (D6) is not built yet. When it lands, the samples this app
        // wrote to Apple Health are deleted here, and EraseText.confirm names them.
        keepUnits(units)
        await reminders?.refresh()
        return outcome
    }

    private func eraseOnPhone() -> Outcome {
        guard store.problem == nil, let record = try? store.phoneText() else { return .refused(EraseText.unreadable) }
        let (history, chatReadable) = chatText()
        let result: HealthEngine.PhoneErase
        do {
            result = try engine.eraseOnPhone(recordJSON: record, historyJSON: history, now: .now, deviceId: store.deviceId)
        } catch {
            return .refused(EraseText.unreadable)
        }
        let chatErased = chatReadable && result.chatErased && chat.keepErased(result.chatHistory)
        do {
            try store.showErased(result.record)
        } catch {
            return .refused(EraseText.notWritten(error.localizedDescription, chatErased: chatErased))
        }
        return .erased(EraseText.done(provider: nil, chatErased: chatErased))
    }

    private func eraseInCloud(_ provider: CloudProvider) async -> Outcome {
        let (history, chatReadable) = chatText()
        guard let result = try? await sync.erase(chatHistory: history), result.erased else {
            return .refused(EraseText.unreachable(provider))
        }
        let chatErased = chatReadable && result.chatErased && chat.keepErased(result.chatHistory)
        return result.success
            ? .erased(EraseText.done(provider: provider, chatErased: chatErased))
            : .notSent(EraseText.notSent(provider: provider, chatErased: chatErased))
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
    private func keepUnits(_ units: String?) {
        guard let units, store.myData?.unitSystem != units else { return }
        _ = store.apply(.units(units))
    }
}
