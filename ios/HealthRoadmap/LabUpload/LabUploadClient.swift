import Foundation

/// Sends one file's pages to the server's lab extraction (US-52 AC7) and returns
/// its answer, the proposed values, as JSON text for the engine. The server
/// stores nothing; the app writes what the user confirms (AC8).
struct LabUploadClient: Sendable {
    var attest: AppAttestClient = .shared

    /// The request body. `ownDates`: the app files a value on its own day;
    /// `refusedRows`: it lists refused rows under "Not saved" (US-12 AC12, AC15).
    /// No `undatedPrev`, so the server leaves out values with no full day (AC14).
    static func body(pages: [LabFileReader.Page], unitSystem: String) throws -> Data {
        struct Body: Encodable {
            let pages: [LabFileReader.Page]
            let unitSystem: String
            let ownDates = true
            let refusedRows = true
        }
        return try JSONEncoder().encode(Body(pages: pages, unitSystem: unitSystem))
    }

    /// The extraction (`data`), as JSON text.
    func extract(_ document: LabFileReader.Document, unitSystem: String) async throws -> String {
        let (bytes, _) = try await attest.post("/api/app/v1/lab-import", body: Self.body(pages: document.pages, unitSystem: unitSystem))
        var data = Data()
        for try await byte in bytes { data.append(byte) }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["success"] as? Bool == true, let extraction = object["data"]
        else { throw AppAttestClient.Failure.badResponse }
        return String(decoding: try JSONSerialization.data(withJSONObject: extraction), as: UTF8.self)
    }
}
