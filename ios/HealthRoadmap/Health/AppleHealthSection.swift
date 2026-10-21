import SwiftUI

/// The Apple Health section of My data (US-25 AC15): one row to connect, then the
/// sync's state. Readings land in the Vitals rows above; typed vitals go to Health.
/// The sync comes from the environment (HealthRoadmapApp), so My data needs one line.
struct AppleHealthSection: View {
    @Environment(AppleHealthSync.self) private var health: AppleHealthSync?

    var body: some View {
        if let health, health.status != .unavailable {
            Section {
                switch health.status {
                case .notConnected, .failed:
                    Button {
                        Task { await health.connect() }
                    } label: {
                        Label("Connect Apple Health", systemImage: "heart.text.square")
                    }
                default:
                    Label(text(health.status), systemImage: "heart.text.square")
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Apple Health")
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    if case .failed(let why) = health.status { Text(why).foregroundStyle(.red) }
                    Text("Weight, height, waist and blood pressure come in from Health. Values you type here go to Health. A value you typed is never replaced by Health, and deleting a reading in Health leaves it here.")
                }
            }
        }
    }

    private func text(_ status: AppleHealthSync.Status) -> String {
        switch status {
        case .working: "Reading Apple Health…"
        case .upToDate(let at): "Up to date, checked \(at.formatted(date: .omitted, time: .shortened))"
        case .waitingForUnlock: "Waiting for the iPhone to be unlocked"
        default: ""
        }
    }
}
