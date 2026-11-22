import Foundation

/// The shared upload's one Save: a lab report's values and its documents (US-52 AC8, AC13d).
/// Split out of RecordStore.swift.
extension RecordStore {
    // MARK: The shared upload's one Save (design PR 15, US-52 AC8c)

    /// Saves the upload whose state is `state`, in the record's turn: in the cloud through the
    /// engine's session at the erase the screen shows, then drawn; on the phone over the record
    /// the save began from, written to the file before it answers. `seen`: the record the page
    /// opened on, refused if the store no longer shows it. A Save that wrote a value is one own
    /// save (US-57 AC9); a document alone is not.
    func saveUpload(state: String, originals: [String: String], read: @escaping @Sendable (String) -> Data?, as seen: Screen) async -> Result<UploadSaveAnswer.Outcome, LabRefusal> {
        let saved = await chain { await self.saveUploadInTurn(state: state, originals: originals, read: read, as: seen) }.value
        if case .success(let outcome) = saved, outcome.values > 0 { ownSaves += 1 }
        return saved
    }

    private func saveUploadInTurn(state: String, originals: [String: String], read: @escaping @Sendable (String) -> Data?, as seen: Screen) async -> Result<UploadSaveAnswer.Outcome, LabRefusal> {
        guard shows(seen) else { return .failure(LabRefusal(message: Self.recordChanged)) }
        if case .predatesErase = hold { return .failure(LabRefusal(message: Self.recordChanged)) }
        if seen.erase == nil, let problem { return .failure(LabRefusal(message: problem.words)) }
        let before = recordJSON
        do {
            let answer = try await engine.uploadSave(state: state, recordJSON: seen.erase == nil ? before : "", erase: seen.erase ?? "",
                                                     now: .now, deviceId: deviceId, originals: originals, read: read)
            guard let answer, answer.ok, let next = answer.record, let outcome = answer.outcome else {
                return .failure(LabRefusal(message: answer?.message ?? Self.uploadNotSaved))
            }
            if let erase = seen.erase {
                // The engine's session took it; the screen follows unless it has moved on to another record.
                guard cloudErase == erase, let nextErase = answer.erase else { return .success(outcome) }
                if next != recordJSON {
                    await draw(next, order: answer.order, as: .cloudEdited(erase: nextErase), holdUndrawn: true)
                    onEdit?()
                }
                return .success(outcome)
            }
            guard try await commitPhoneDocument(next, over: before) else {
                return .failure(LabRefusal(message: Self.changedWhileSaving))
            }
            return .success(outcome)
        } catch {
            return .failure(LabRefusal(message: Self.uploadNotSaved))
        }
    }

    /// A refused or failed save.
    static let uploadNotSaved = "That could not be saved."
    /// A save another writer overtook.
    static let changedWhileSaving = "Your record changed while this was saving, so it was not saved. Save again."
}
