import Observation
import SwiftUI

/// What "From Dropbox" shows of the app folder: loading, the lab files, or why
/// not. Kept apart from the view so a test can drive it (review: a sign-in
/// after a refused listing must list afresh).
@MainActor
@Observable
final class DropboxLabFolder {
    enum Load: Equatable {
        case loading
        case files([HealthEngine.CloudLabFile])
        case failed(SyncProblem.Kind)
    }

    private(set) var load = Load.loading
    private let engine: HealthEngine
    private let sync: CloudSync

    init(engine: HealthEngine, sync: CloudSync) {
        self.engine = engine
        self.sync = sync
    }

    /// List the folder again, keeping the files on screen while it does.
    func refresh() async {
        guard sync.provider == .dropbox else { return }
        if case .files = load {} else { load = .loading }
        do {
            load = .files(try await engine.labFiles())
        } catch {
            load = .failed(SyncProblem(error).kind)
        }
    }

    /// A Connect or "Sign in again" here worked: the provider may not have
    /// changed, so nothing else re-lists.
    func signedIn() async {
        load = .loading
        await refresh()
    }
}

/// "From Dropbox" under "+" (US-52 AC11). Not connected: what connecting does,
/// then Sync's own sign-in. Connected: the lab files in the app folder, newest
/// first, listed by the engine (health-core's dropbox-rest), one tap to read.
struct DropboxLabFiles: View {
    let engine: HealthEngine
    let sync: CloudSync
    let pick: (HealthEngine.CloudLabFile) -> Void
    let browseFiles: () -> Void

    @State private var folder: DropboxLabFolder

    init(engine: HealthEngine, sync: CloudSync, pick: @escaping (HealthEngine.CloudLabFile) -> Void, browseFiles: @escaping () -> Void) {
        self.engine = engine
        self.sync = sync
        self.pick = pick
        self.browseFiles = browseFiles
        _folder = State(initialValue: DropboxLabFolder(engine: engine, sync: sync))
    }

    var body: some View {
        List {
            switch sync.provider {
            case nil: notConnected
            case .googleDrive?: otherCloud
            case .dropbox?: listing
            }
            Section {
                Button("Browse Files instead", systemImage: "folder", action: browseFiles)
            } footer: {
                Text("The app sees only its own Dropbox folder. For a report anywhere else in Dropbox, use Files with the Dropbox app installed.")
            }
        }
        .navigationTitle("From Dropbox")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await folder.refresh() }
        // Runs again once a Connect here sets the provider.
        .task(id: sync.provider) { await folder.refresh() }
    }

    private var notConnected: some View {
        Section {
            VStack(alignment: .leading, spacing: 12) {
                Text("Connect your Dropbox")
                    .font(.headline)
                Text("Put your lab reports in \(CloudProvider.dropbox.folder). The app can open that folder and nothing else in your Dropbox.")
                Text("Connecting also keeps your record in that folder, in the file the website uses, so your phone and the website stay in step.")
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
            ConnectCloudButton(sync: sync, provider: .dropbox, connected: { Task { await folder.signedIn() } }) {
                Label("Connect Dropbox", systemImage: "link")
            }
        }
    }

    private var otherCloud: some View {
        Section {
            Text("This iPhone syncs with Google Drive. The app connects to one cloud at a time, so it cannot open your Dropbox now. To use Dropbox, disconnect Google Drive in Sync.")
        }
    }

    @ViewBuilder
    private var listing: some View {
        switch folder.load {
        case .loading:
            Section {
                HStack(spacing: 12) {
                    ProgressView()
                    Text("Looking in your Dropbox folder")
                }
            }
        case .files(let files) where files.isEmpty:
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text("No lab reports here yet")
                        .font(.headline)
                    Text("Put a PDF, a photo (JPEG or PNG) or a ZIP in \(CloudProvider.dropbox.folder), then pull down to refresh.")
                }
                .padding(.vertical, 4)
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await folder.refresh() } }
            }
        case .files(let files):
            Section {
                ForEach(files) { file in
                    Button { pick(file) } label: { LabFileRow(file: file) }
                }
            } header: {
                Text("In \(CloudProvider.dropbox.folder)")
            } footer: {
                Text("Tap a report to read its values. You check them before anything is saved.")
            }
        case .failed(.signIn):
            Section {
                Text("Dropbox needs you to sign in again.")
                ConnectCloudButton(sync: sync, provider: .dropbox, connected: { Task { await folder.signedIn() } }) {
                    Label("Sign in to Dropbox again", systemImage: "person.badge.key")
                }
            }
        case .failed:
            Section {
                Text("Dropbox could not be reached. Check the connection and try again.")
                Button("Try again", systemImage: "arrow.clockwise") { Task { await folder.refresh() } }
            }
        }
    }

}

/// One file in the Dropbox list: its kind, name, day and size.
private struct LabFileRow: View {
    let file: HealthEngine.CloudLabFile

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(.tint)
                .frame(width: 32)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name)
                    .foregroundStyle(Color.primary)
                    .lineLimit(2)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(Color.secondary)
            }
        }
    }

    private var symbol: String {
        switch (file.name as NSString).pathExtension.lowercased() {
        case "pdf": "doc.richtext"
        case "zip": "doc.zipper"
        default: "photo"
        }
    }

    /// When it was added, in the phone's zone (Dropbox gives the moment in UTC), and its size.
    private var detail: String {
        let size = Int64(file.size).formatted(.byteCount(style: .file))
        guard let when = try? Date(file.modified, strategy: .iso8601) else { return size }
        return "\(when.formatted(date: .abbreviated, time: .omitted)) · \(size)"
    }
}

/// "From Google Drive" under "+" (US-52 AC12). Not connected: Sync's own sign-in,
/// as for Dropbox. Drive's `drive.file` access sees only the files the app made,
/// so a report there always comes in through Files, connected or not.
struct GoogleDriveLabFiles: View {
    let sync: CloudSync
    let browseFiles: () -> Void

    var body: some View {
        List {
            switch sync.provider {
            case nil: connect
            case .dropbox?:
                Section {
                    Text("This iPhone syncs with Dropbox. The app connects to one cloud at a time. You can still pick a report from Google Drive below.")
                }
            case .googleDrive?:
                Section {
                    LabeledContent("Connected to", value: CloudProvider.googleDrive.label)
                } footer: {
                    Text("Your record is kept in \(CloudProvider.googleDrive.folder).")
                }
            }
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Reports open through Files")
                        .font(.headline)
                    Text("Google lets the app see only the record it saves, not the files you put in Google Drive. So pick a report in Files: tap Browse, then Google Drive. The Google Drive app needs to be on this iPhone.")
                }
                .padding(.vertical, 4)
                Button("Choose from Google Drive", systemImage: "folder", action: browseFiles)
            }
        }
        .navigationTitle("From Google Drive")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var connect: some View {
        Section {
            VStack(alignment: .leading, spacing: 12) {
                Text("Connect your Google Drive")
                    .font(.headline)
                Text("Connecting keeps your record in \(CloudProvider.googleDrive.folder), the file the website uses, so your phone and the website stay in step.")
                if !CloudProvider.googleDrive.isConfigured {
                    Text("Google Drive sign-in is not set up in this version of the app yet.")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
            ConnectCloudButton(sync: sync, provider: .googleDrive, connected: {}) {
                Label("Connect Google Drive", systemImage: "link")
            }
        }
    }
}
