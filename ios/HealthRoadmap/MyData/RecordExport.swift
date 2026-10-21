import CoreTransferable
import UniformTypeIdentifiers

/// "Export my record" (US-25 AC13): the record as the one file the web keeps,
/// `health-roadmap.json`, in the web's schema, for the share sheet. The app
/// saves no copy itself: the bytes go to the share sheet, which writes the file.
struct RecordExport: Transferable {
    static let fileName = "health-roadmap.json"

    /// The record as shown: the phone's file, or the cloud record when one is open.
    let json: String

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .json) { Data($0.json.utf8) }
            .suggestedFileName(fileName)
    }
}
