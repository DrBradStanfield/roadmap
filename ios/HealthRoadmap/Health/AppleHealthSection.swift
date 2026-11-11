import SwiftUI

/// The Apple Health section of My health's settings sheet (US-25 AC15): one row to connect,
/// then the sync's state. Readings land in My health's rows; typed values go to Health.
/// The sync comes from the environment (HealthRoadmapApp), so the sheet needs one line.
struct AppleHealthSection: View {
    @Environment(AppleHealthSync.self) private var health: AppleHealthSync?
    /// US-56: the live cards' disclosure lives here now (My health, round 4), said once.
    @Environment(LiveHealth.self) private var live: LiveHealth?

    var body: some View {
        if let health, health.status != .unavailable {
            Section {
                if health.connected {
                    Label(Self.text(health.status), systemImage: "heart.text.square")
                        .foregroundStyle(.secondary)
                    // US-72 AC14: Apple's sheet only, when HealthKit has results to ask about.
                    if health.offersLabResults {
                        Button {
                            Task { await health.shareNewLabResults() }
                        } label: {
                            Label("Share new lab results", systemImage: "list.clipboard")
                        }
                    }
                } else {
                    Button {
                        Task { await health.connect() }
                    } label: {
                        Label("Connect Apple Health", systemImage: "heart.text.square")
                    }
                }
            } header: {
                SectionTitle.appleHealth()
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    if health.offersLabResults { Text("Opens Apple Health when your provider has sent new results.") }
                    if case .failed(let why) = health.status { Text(why).foregroundStyle(.red) }
                    if health.status == .notAllowed { Text(LiveFooter.access) }
                    if health.owedFooter { Text(EraseText.healthOwed) }
                    Text("Weight, height, waist and blood pressure come in from Health. Values you type here go to Health. A value you typed is never replaced by Health, and deleting a reading in Health leaves it here.")
                    if live?.available == true { Text(LiveFooter.cards) }
                }
            }
        } else if live?.available == true {
            // No record sync here (a demo record), but the live cards still read Health.
            Section {
            } header: {
                SectionTitle.appleHealth()
            } footer: {
                Text(LiveFooter.cards)
            }
        }
    }

    static func text(_ status: AppleHealthSync.Status) -> String {
        switch status {
        case .working: "Reading Apple Health…"
        case .upToDate(let at): "Up to date, checked \(at.formatted(date: .omitted, time: .shortened))"
        case .waitingForUnlock: "Waiting for the iPhone to be unlocked"
        case .notAllowed: "Apple Health isn't connected"
        default: ""
        }
    }
}
