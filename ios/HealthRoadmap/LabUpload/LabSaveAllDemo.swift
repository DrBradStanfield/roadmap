import SwiftUI

extension View {
    /// DEBUG only: opens the upload sheet on a save-all demo stage (US-52 AC8b); a no-op in release.
    func labSaveAllDemo(_ adding: Binding<Bool>) -> some View {
        #if DEBUG
        task { if LabSaveAllDemo.stage != nil { adding.wrappedValue = true } }
        #else
        self
        #endif
    }
}

#if DEBUG

/// DEBUG only, never in a release build: with `--demo-record` and `--demo-save-all=<stage>`,
/// My health opens "Add medical records" on a save-all screen (US-52 AC8b) built from
/// made-up reports, so the design can be shot in the simulator without a lab read or the
/// server. Stages: review, saving, summary, opened (a review opened from the summary).
enum LabSaveAllDemo {
    static let prefix = "--demo-save-all="

    static var stage: String? {
        guard DemoRecord.isOn else { return nil }
        return ProcessInfo.processInfo.arguments.first { $0.hasPrefix(prefix) }.map { String($0.dropFirst(prefix.count)) }
    }

    static var step: LabUploadFlow.Step? {
        guard let stage else { return nil }
        let summary = SaveAllSummary(progress(done: results.count))
        switch stage {
        case "review": return .review(results, index: 0)
        case "saving": return .savingAll(results, progress(done: 1))
        case "summary": return .saveAllDone(results, summary)
        case "opened": return .review(results, index: 2, from: summary)
        default: return nil
        }
    }

    private static func progress(done: Int) -> SaveAllProgress {
        var progress = SaveAllProgress(reports: Array(results.indices))
        let outcomes: [ReportOutcome] = [.saved(values: 2, documents: 0), .saved(values: 0, documents: 1),
                                         .notSaved("Needs the test day"), .notSaved("Could not be read"), .saved(values: 1, documents: 0)]
        for i in 0..<done { progress.outcomes[i] = outcomes[i] }
        if done < results.count { progress.inFlight.insert(done) }
        return progress
    }

    static let results: [LabResult] = [
        LabResult(name: "Bloods October.pdf", truncated: false, extractionJSON: dated, failure: nil),
        LabResult(name: "Cardiology letter.pdf", truncated: false, extractionJSON: letter, failure: nil),
        LabResult(name: "Old lipid panel.jpg", truncated: false, extractionJSON: undated, failure: nil),
        LabResult(name: "Blurry scan.jpg", truncated: false, extractionJSON: nil, failure: "The AI could not read this file."),
        LabResult(name: "Thyroid check.pdf", truncated: false, extractionJSON: thyroid, failure: nil),
    ]

    private static let dated = #"""
    {"classification":"lab_report","reportDate":"2026-10-01",
     "values":[{"metric":"ldl","valueSI":3.1,"displayValue":3.1,"displayUnit":"mmol/L","displaySystem":"si","confidence":"high"},
               {"metric":"hba1c","valueSI":40,"displayValue":40,"displayUnit":"mmol/mol","displaySystem":"si","confidence":"medium","question":"Was this a blood test?"}],
     "additionalValues":[], "refusedValues":[]}
    """#
    private static let undated = #"""
    {"classification":"lab_report","reportDate":null,
     "values":[{"metric":"hdl","valueSI":1.4,"displayValue":1.4,"displayUnit":"mmol/L","displaySystem":"si","confidence":"high"}],
     "additionalValues":[], "refusedValues":[]}
    """#
    private static let thyroid = #"""
    {"classification":"lab_report","reportDate":"2026-08-12",
     "values":[{"metric":"ldl","valueSI":2.9,"displayValue":2.9,"displayUnit":"mmol/L","displaySystem":"si","confidence":"high"}],
     "additionalValues":[], "refusedValues":[]}
    """#
    private static let letter = ##"{"classification":"clinic_letter","reportDate":null,"values":[],"additionalValues":[],"document":{"classification":"clinic_letter","title":"Cardiology follow-up","documentDate":"2026-09-14","contentMarkdown":"# Letter","metadata":{}}}"##
}
#endif
