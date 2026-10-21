import Foundation

/// Where downloaded engines wait (US-25 AC17): `Application Support/Engine`, left out
/// of backups like the record. Each release is three files named by its version
/// (`<v>.js`, `<v>.manifest.json`, `<v>.manifest.sig`) and one state file says what
/// this phone has decided. Swift never trusts a file here without checking it again.
struct EngineFolder {
    /// What this phone remembers about updates.
    struct State: Codable, Equatable {
        /// The highest version ever accepted here; nothing at or below it is fetched again.
        var highWater = 0
        /// The highest `minVersion` a signed manifest has set; nothing below it loads.
        var floor = 0
        /// Versions that failed a check, a self-test or a launch. Never tried again.
        var bad: [Int] = []
        /// Versions that passed a foreground launch; only these load on a background launch.
        var proven: [Int] = []
        /// The version on trial: set before its first foreground load, cleared when it passes.
        /// Still set at a later launch means that load crashed or hung.
        var trying: Int?
        var lastCheck: Date?
    }

    /// The staged files of one version, read once into memory.
    struct Staged {
        let version: Int
        let bundle: Data
        let manifest: Data
        let signature: Data
    }

    let url: URL

    static func live() throws -> EngineFolder {
        try EngineFolder(base: .applicationSupportDirectory)
    }

    init(base: URL) throws {
        var folder = base.appending(path: "Engine", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try folder.setResourceValues(values)
        url = folder
    }

    private var stateFile: URL { url.appending(path: "state.json") }

    /// Throws when the state cannot be read (before first unlock, say): the caller then
    /// changes nothing and runs the bundled engine. No file yet is a fresh state.
    func readState() throws -> State {
        guard FileManager.default.fileExists(atPath: stateFile.path(percentEncoded: false)) else { return State() }
        return try JSONDecoder().decode(State.self, from: Data(contentsOf: stateFile))
    }

    func write(_ state: State) throws {
        try JSONEncoder().encode(state).write(to: stateFile, options: .atomic)
    }

    /// The versions with a staged bundle, newest first.
    func stagedVersions() -> [Int] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: url.path(percentEncoded: false))) ?? []
        return names.compactMap { $0.hasSuffix(".js") ? Int($0.dropLast(3)) : nil }.sorted(by: >)
    }

    /// Reads a staged version's three files. Throws when they cannot be read now.
    func read(_ version: Int) throws -> Staged {
        Staged(
            version: version,
            bundle: try Data(contentsOf: file(version, "js")),
            manifest: try Data(contentsOf: file(version, "manifest.json")),
            signature: try Data(contentsOf: file(version, "manifest.sig"))
        )
    }

    /// Writes a verified release. The bundle goes last, so a version only counts as
    /// staged (`stagedVersions` lists `.js`) once its manifest and signature are there.
    func stage(_ staged: Staged) throws {
        try staged.manifest.write(to: file(staged.version, "manifest.json"), options: .atomic)
        try staged.signature.write(to: file(staged.version, "manifest.sig"), options: .atomic)
        try staged.bundle.write(to: file(staged.version, "js"), options: .atomic)
    }

    func remove(_ version: Int) {
        for kind in ["js", "manifest.json", "manifest.sig"] { try? FileManager.default.removeItem(at: file(version, kind)) }
    }

    private func file(_ version: Int, _ kind: String) -> URL {
        url.appending(path: "\(version).\(kind)")
    }
}
