// Generated from ios/engine/contract.ts by `npx tsx ios/scripts/gen-contract.ts`. Never edit it:
// ios/engine/contract-drift.test.ts fails when it differs from what the contract generates.
// contractHash: feb576c1d7928941

import Foundation
import JavaScriptCore

extension HealthEngine {

    /// `applyEditJson`: answers at once.
    func doorApplyEditJson(recordJson: String, editJson: String, nowIso: String, deviceId: String, unitsJson: String) throws -> EditOutcome {
        try JSONDecoder().decode(EditOutcome.self, from: Data(call("applyEditJson", [recordJson, editJson, nowIso, deviceId, unitsJson]).utf8))
    }

    /// `chatContextJson`: answers at once.
    func doorChatContextJson(recordJson: String, nowIso: String, deviceId: String) throws -> String {
        try call("chatContextJson", [recordJson, nowIso, deviceId])
    }

    /// `chatEditsJson`: answers at once.
    func doorChatEditsJson(recordJson: String, editsJson: String, nowIso: String, deviceId: String, today: String, unitsJson: String) throws -> String {
        try call("chatEditsJson", [recordJson, editsJson, nowIso, deviceId, today, unitsJson])
    }

    /// `chatDeleteJson`: a settle door, read through settledJson.
    func doorChatDeleteJson<T: Decodable>(_ type: T.Type, historyText: String?, conversationId: String, nowIso: String, deviceId: String) throws -> T {
        try settled(type, "chatDeleteJson", [historyText.map { $0 as Any } ?? NSNull(), conversationId, nowIso, deviceId])
    }

    /// `chatListJson`: a settle door, read through settledJson.
    func doorChatListJson<T: Decodable>(_ type: T.Type, historyText: String?, nowIso: String, deviceId: String) throws -> T {
        try settled(type, "chatListJson", [historyText.map { $0 as Any } ?? NSNull(), nowIso, deviceId])
    }

    /// `chatMessagesJson`: a settle door, read through settledJson.
    func doorChatMessagesJson<T: Decodable>(_ type: T.Type, historyText: String?, conversationId: String, nowIso: String, deviceId: String) throws -> T {
        try settled(type, "chatMessagesJson", [historyText.map { $0 as Any } ?? NSNull(), conversationId, nowIso, deviceId])
    }

    /// `chatRecordExchangeJson`: a settle door, read through settledJson.
    func doorChatRecordExchangeJson<T: Decodable>(_ type: T.Type, historyText: String?, exchangeJson: String, nowIso: String, deviceId: String) throws -> T {
        try settled(type, "chatRecordExchangeJson", [historyText.map { $0 as Any } ?? NSNull(), exchangeJson, nowIso, deviceId])
    }

    /// `cloudClose`: answers a Promise.
    func doorCloudClose(copyDown: Bool) async throws -> String {
        try await callAsync("cloudClose", [copyDown])
    }

    /// `cloudClose`, its settled value read by `read` on the engine's queue.
    func doorCloudClose<T: Sendable>(copyDown: Bool, read: @escaping (JSValue) -> T) async throws -> T {
        try await callAsync("cloudClose", [copyDown], read: read)
    }

    /// `cloudEdit`: answers at once.
    func doorCloudEdit(editJson: String, erase: String, shownUnits: String, nowIso: String, unitsJson: String, shownLpaUnit: String) throws -> EditOutcome {
        try JSONDecoder().decode(EditOutcome.self, from: Data(call("cloudEdit", [editJson, erase, shownUnits, nowIso, unitsJson, shownLpaUnit]).utf8))
    }

    /// `cloudErase`: answers a Promise.
    func doorCloudErase(historyText: String?, nowIso: String, keepChat: AnyObject) async throws -> String {
        try await callAsync("cloudErase", [historyText.map { $0 as Any } ?? NSNull(), nowIso, keepChat])
    }

    /// `cloudErase`, its settled value read by `read` on the engine's queue.
    func doorCloudErase<T: Sendable>(historyText: String?, nowIso: String, keepChat: AnyObject, read: @escaping (JSValue) -> T) async throws -> T {
        try await callAsync("cloudErase", [historyText.map { $0 as Any } ?? NSNull(), nowIso, keepChat], read: read)
    }

    /// `cloudFlush`: answers a Promise.
    func doorCloudFlush() async throws -> String {
        try await callAsync("cloudFlush", [])
    }

    /// `cloudFlush`, its settled value read by `read` on the engine's queue.
    func doorCloudFlush<T: Sendable>(read: @escaping (JSValue) -> T) async throws -> T {
        try await callAsync("cloudFlush", [], read: read)
    }

    /// `cloudHidden`: answers at once.
    func doorCloudHidden() throws -> String {
        try call("cloudHidden", [])
    }

    /// `cloudLabImport`: answers at once.
    func doorCloudLabImport(extractionJson: String, refsJson: String, reportDay: String, erase: String, shownUnits: String, nowIso: String, unitsJson: String) throws -> String {
        try call("cloudLabImport", [extractionJson, refsJson, reportDay, erase, shownUnits, nowIso, unitsJson])
    }

    /// `cloudOpen`: answers a Promise.
    func doorCloudOpen(provider: String, deviceId: String, firstConnect: Bool, mergePhone: Bool) async throws -> String {
        try await callAsync("cloudOpen", [provider, deviceId, firstConnect, mergePhone])
    }

    /// `cloudOpen`, its settled value read by `read` on the engine's queue.
    func doorCloudOpen<T: Sendable>(provider: String, deviceId: String, firstConnect: Bool, mergePhone: Bool, read: @escaping (JSValue) -> T) async throws -> T {
        try await callAsync("cloudOpen", [provider, deviceId, firstConnect, mergePhone], read: read)
    }

    /// `cloudRefresh`: answers a Promise.
    func doorCloudRefresh() async throws -> String {
        try await callAsync("cloudRefresh", [])
    }

    /// `cloudRefresh`, its settled value read by `read` on the engine's queue.
    func doorCloudRefresh<T: Sendable>(read: @escaping (JSValue) -> T) async throws -> T {
        try await callAsync("cloudRefresh", [], read: read)
    }

    /// `cloudVisible`: answers at once.
    func doorCloudVisible() throws -> String {
        try call("cloudVisible", [])
    }

    /// `documentSave`: answers a Promise.
    func doorDocumentSave(recordJson: String, extractionJson: String, choiceJson: String, original: Data?, erase: String, nowIso: String, deviceId: String) async throws -> String {
        try await callAsync("documentSave", [recordJson, extractionJson, choiceJson, original.map { arrayBuffer($0) as Any } ?? NSNull(), erase, nowIso, deviceId])
    }

    /// `documentSave`, its settled value read by `read` on the engine's queue.
    func doorDocumentSave<T: Sendable>(recordJson: String, extractionJson: String, choiceJson: String, original: Data?, erase: String, nowIso: String, deviceId: String, read: @escaping (JSValue) -> T) async throws -> T {
        try await callAsync("documentSave", [recordJson, extractionJson, choiceJson, original.map { arrayBuffer($0) as Any } ?? NSNull(), erase, nowIso, deviceId], read: read)
    }

    /// `erasePhoneJson`: a settle door, read through settledJson.
    func doorErasePhoneJson<T: Decodable>(_ type: T.Type, recordText: String, historyText: String?, nowIso: String, deviceId: String) throws -> T {
        try settled(type, "erasePhoneJson", [recordText, historyText.map { $0 as Any } ?? NSNull(), nowIso, deviceId])
    }

    /// `healthWritesJson`: answers at once.
    func doorHealthWritesJson(recordJson: String, nowIso: String, deviceId: String) throws -> String {
        try call("healthWritesJson", [recordJson, nowIso, deviceId])
    }

    /// `historyJson`: answers at once.
    func doorHistoryJson(recordJson: String, metric: String, nowIso: String, deviceId: String, unitsJson: String, series: String? = nil) throws -> String {
        var arguments: [Any] = [recordJson, metric, nowIso, deviceId, unitsJson]
        if let series { arguments.append(series) }
        try call("historyJson", arguments)
    }

    /// `labReviewJson`: answers at once.
    func doorLabReviewJson(extractionJson: String, nowIso: String, recordJson: String, sourceFileName: String, contentHash: String, deviceId: String) throws -> String {
        try call("labReviewJson", [extractionJson, nowIso, recordJson, sourceFileName, contentHash, deviceId])
    }

    /// `labSaveSummaryJson`: answers at once.
    func doorLabSaveSummaryJson(recordJson: String, extractionJson: String, refsJson: String, reportDay: String, nowIso: String, deviceId: String) throws -> String {
        try call("labSaveSummaryJson", [recordJson, extractionJson, refsJson, reportDay, nowIso, deviceId])
    }

    /// `mergeJson`: answers at once.
    func doorMergeJson(localJson: String, remoteJson: String, nowIso: String, deviceId: String) throws -> String {
        try call("mergeJson", [localJson, remoteJson, nowIso, deviceId])
    }

    /// `newRecordJson`: answers at once.
    func doorNewRecordJson(nowIso: String, deviceId: String, locale: String, timeZone: String) throws -> String {
        try call("newRecordJson", [nowIso, deviceId, locale, timeZone])
    }

    /// `numberJson`: answers at once.
    func doorNumberJson(text: String) throws -> String {
        try call("numberJson", [text])
    }

    /// `convertJson`: answers at once.
    func doorConvertJson(metric: String, value: Double, from: String, to: String) throws -> UnitConversion {
        try JSONDecoder().decode(UnitConversion.self, from: Data(call("convertJson", [metric, value, from, to]).utf8))
    }

    /// `planJson`: answers at once.
    func doorPlanJson(recordJson: String, nowIso: String, deviceId: String, unitsJson: String) throws -> String {
        try call("planJson", [recordJson, nowIso, deviceId, unitsJson])
    }

    /// `remindersJson`: answers at once.
    func doorRemindersJson(recordJson: String, nowIso: String, deviceId: String, firstSeenJson: String? = nil) throws -> String {
        var arguments: [Any] = [recordJson, nowIso, deviceId]
        if let firstSeenJson { arguments.append(firstSeenJson) }
        try call("remindersJson", arguments)
    }

    /// `screenJson`: answers at once.
    func doorScreenJson(recordJson: String, nowIso: String, deviceId: String, unitsJson: String, isUS: Bool? = nil) throws -> String {
        var arguments: [Any] = [recordJson, nowIso, deviceId, unitsJson]
        if let isUS { arguments.append(isUS) }
        try call("screenJson", arguments)
    }

    /// `sectionsJson`: answers at once.
    func doorSectionsJson(planJson: String) throws -> String {
        try call("sectionsJson", [planJson])
    }

    /// `fileNamesJson`: answers at once.
    func doorFileNamesJson(filesJson: String) throws -> String {
        try call("fileNamesJson", [filesJson])
    }

    /// `settledJson`: answers at once.
    func doorSettledJson() throws -> String {
        try call("settledJson", [])
    }

    /// `labSearchJson`: answers at once; nil from an engine without it.
    func doorLabSearchJson(text: String) throws -> String? {
        try optionalCall("labSearchJson", [text])
    }

    /// `documentOriginal`: answers a Promise; nil from an engine without it.
    func doorDocumentOriginal(id: String) async throws -> String? {
        try await optionalCall("documentOriginal", [id], read: { $0.isUndefined ? "" : $0.toString() })
    }

    /// `documentOriginal`, its settled value read by `read` on the engine's queue.
    func doorDocumentOriginal<T: Sendable>(id: String, read: @escaping (JSValue) -> T) async throws -> T? {
        try await optionalCall("documentOriginal", [id], read: read)
    }

    /// `uploadVerdictsJson`: answers at once; nil from an engine without it.
    func doorUploadVerdictsJson(request: String) throws -> String? {
        try optionalCall("uploadVerdictsJson", [request])
    }

    /// `cloudOnline`: answers at once; nil from an engine without it.
    func doorCloudOnline() throws -> String? {
        try optionalCall("cloudOnline", [])
    }
}
