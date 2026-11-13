import Foundation

/// Saving a lab report's values and filing a document (US-52 AC8, AC13d).
/// Split out of RecordStore.swift.
extension RecordStore {
    // MARK: Lab reports (US-52 AC8)

    /// The ticked values of a lab report, and what saving them did. The summary is taken
    /// in the same turn as the import, against the record it lands on (in the cloud, the
    /// session's working copy, in one engine step), so it never counts a value another
    /// device brought in meanwhile as saved (Codex re-check R3).
    func importLabs(extractionJSON: String, refs: [String], reportDay: String) async -> Result<LabSaveSummary, LabRefusal> {
        let seen = pinned ?? screen
        let (result, changed) = await chain {
            let before = self.recordJSON
            return (await self.importLabsInTurn(extractionJSON: extractionJSON, refs: refs, reportDay: reportDay, as: seen), self.recordJSON != before)
        }.value
        if changed, case .success = result { ownSaves += 1 }
        return result
    }

    private func importLabsInTurn(extractionJSON: String, refs: [String], reportDay: String, as seen: Screen) async -> Result<LabSaveSummary, LabRefusal> {
        // Another record since the review opened (a sync, a Disconnect's read): refused before
        // anything is read against the record now shown, as `applyInTurn` refuses it.
        guard seen.erase == cloudErase, seen.mark.holds(at: mark) else { return .failure(LabRefusal(message: Self.recordChanged)) }
        let edit = RecordEdit.labImport(extractionJSON: extractionJSON, refs: refs, reportDay: reportDay)
        do {
            let summary: Result<LabSaveSummary, LabRefusal>
            let result: ApplyResult
            if let erase = seen.erase {
                let answer = try await engine.cloudLabImport(extractionJSON: extractionJSON, refs: refs, reportDay: reportDay, erase: erase,
                                                             units: seen.units, now: .now, choices: seen.choices)
                result = await shown(answer.outcome, order: answer.order, of: edit)
                summary = answer.summary.map { .success($0) } ?? .failure(LabRefusal(message: answer.outcome.message ?? "These values could not be saved."))
            } else {
                if let problem { return .failure(LabRefusal(message: problem.words)) }
                // The phone's file: nothing else changes the record before this turn ends.
                summary = try await engine.labSaveSummary(recordJSON: recordJSON, extractionJSON: extractionJSON, refs: refs, reportDay: reportDay, now: .now, deviceId: deviceId)
                guard case .success = summary else { return summary }
                result = await applyInTurn(edit, as: seen)
            }
            if case .refused(let message, _) = result { return .failure(LabRefusal(message: message)) }
            return summary
        } catch {
            return .failure(LabRefusal(message: error.localizedDescription))
        }
    }

    // MARK: Documents (US-52 AC13d)

    /// What filing a document did.
    enum DocumentResult: Equatable {
        /// `stored`: the original reached the cloud (nil: none was offered to one).
        /// `unstored`: held originals that still could not be stored. `stale`: the original
        /// changed or could not be read after the review, so only its text was saved.
        case saved(count: Int, stored: Bool?, unstored: Int, stale: Bool)
        case refused(String)
    }

    /// Files one reviewed document, or a lab report's original, by health-core's
    /// saveDocuments, the web's one save path. In the cloud: the original goes up first,
    /// then the rows through the engine's session, with the erase the screen showed.
    /// On the phone: a text-only row (no original), written to the file as an edit is.
    func saveDocument(extractionJSON: String, choice: DocumentChoice, original: LabFileReader.Original?) async -> DocumentResult {
        let seen = pinned ?? screen
        return await chain { await self.saveDocumentInTurn(extractionJSON: extractionJSON, choice: choice, original: original, as: seen) }.value
    }

    private func saveDocumentInTurn(extractionJSON: String, choice: DocumentChoice, original: LabFileReader.Original?, as seen: Screen) async -> DocumentResult {
        guard seen.erase == cloudErase, seen.mark.holds(at: mark) else {
            return .refused("Your record changed while this was open, so this was not saved. Close this and try again.")
        }
        if seen.erase == nil, let problem { return .refused(problem.words) }
        let before = recordJSON
        do {
            // The engine decides whether an original is kept (only in a cloud); off-cloud
            // the file is not even read, since it would go nowhere. Read now, it must be
            // the bytes the review read (their hash), or it is left out.
            let bytes = seen.erase == nil ? nil : original?.verifiedData()
            let answer = try await engine.documentSave(
                recordJSON: seen.erase == nil ? before : "", extractionJSON: extractionJSON, choice: choice,
                original: bytes, erase: seen.erase ?? "", now: .now, deviceId: deviceId)
            guard answer.ok, let next = answer.record else { return .refused(answer.message ?? "That could not be saved.") }
            let result = DocumentResult.saved(count: answer.saved ?? 0, stored: answer.stored, unstored: answer.unstored ?? 0, stale: answer.stale ?? false)
            if let erase = seen.erase {
                // The engine's session took it; the screen follows unless it has moved on to another record.
                guard cloudErase == erase, let nextErase = answer.erase else { return result }
                if next != recordJSON {
                    await draw(next, order: answer.order, as: .cloudEdited(erase: nextErase))
                    onEdit?()
                }
                return result
            }
            guard try await commitPhoneDocument(next, over: before) else {
                return .refused("Your record changed while this was saving, so it was not saved. Save again.")
            }
            return result
        } catch {
            return .refused(error.localizedDescription)
        }
    }
}
