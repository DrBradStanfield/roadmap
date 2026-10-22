import SwiftUI

/// The first screen a new user sees, once (US-25 AC8): what the app does, where
/// their data lives, and that it is education, not medical advice (App Review
/// 1.4.1). Both ways on sit under that line, so nobody misses it. "I already use
/// Health Roadmap" connects the cloud the website uses, so a web user's record
/// comes in instead of being typed again (US-54 AC2).
struct WelcomeView: View {
    let sync: CloudSync?
    let start: () -> Void
    /// A cloud connected from the welcome screen.
    var connected: () -> Void = {}
    @State private var shown = false
    @State private var choosingCloud = false
    /// Signed in, but the cloud record did not open: say so, and stay (US-54 AC2).
    @State private var notOpened = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 24)
            hero
                .scaleEffect(shown ? 1 : 0.6)
                .opacity(shown ? 1 : 0)
            Text("Your health roadmap")
                .font(.largeTitle.bold())
                .multilineTextAlignment(.center)
                .padding(.top, 28)
            Text("By Dr Brad Stanfield")
                .font(.headline)
                .foregroundStyle(.secondary)
                .padding(.top, 4)

            VStack(alignment: .leading, spacing: 22) {
                point("list.bullet.clipboard", "Add your numbers", "Height, weight, blood pressure and blood tests. Apple Health and lab reports can fill them in.")
                point("heart.text.square", "See your next steps", "A plan built from published guidelines, with the evidence behind each step.")
                point("lock.shield", "Your data stays yours", "Your record lives on this iPhone, or in your own Dropbox or Google Drive, never on our servers.")
            }
            .padding(.top, 36)
            .padding(.horizontal, 8)
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : 20)

            Spacer(minLength: 24)
            Text("For education only, not medical advice. Talk to your doctor before you change anything about your health or medicines.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button(action: getStarted) {
                Text("Get started").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6).onAccentLabel()
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.top, 16)
            .accessibilityIdentifier("welcome.start")
            if sync != nil {
                Button("I already use Health Roadmap") { choosingCloud = true }
                    .padding(.top, 10)
                    .accessibilityIdentifier("welcome.existing")
            }
        }
        .sheet(isPresented: $choosingCloud) {
            if let sync { cloudChooser(sync) }
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 12)
        .onAppear {
            withAnimation(.spring(duration: 0.8, bounce: 0.35)) { shown = true }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: shown)
    }

    /// The icon's idea in symbols: a road that ends at a heart.
    private var hero: some View {
        ZStack {
            Circle()
                .fill(LinearGradient(colors: [Color(red: 0.2, green: 0.83, blue: 0.47), Color(red: 0.03, green: 0.47, blue: 0.43)], startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 120, height: 120)
                .shadow(color: .green.opacity(0.3), radius: 20, y: 10)
            Image(systemName: "point.bottomleft.forward.to.point.topright.scurvepath.fill")
                .font(.system(size: 50, weight: .semibold))
                .foregroundStyle(.white)
                .offset(x: -6, y: 8)
            Image(systemName: "heart.fill")
                .font(.system(size: 26))
                .foregroundStyle(Color(red: 1, green: 0.27, blue: 0.35))
                .offset(x: 26, y: -26)
                .symbolEffect(.bounce, value: shown)
        }
        .accessibilityHidden(true)
    }

    /// Where the website keeps the record: Sync's own connect buttons (US-25 AC11).
    private func cloudChooser(_ sync: CloudSync) -> some View {
        NavigationStack {
            List {
                Section { SyncDiagram() }
                Section {
                    ForEach(CloudProvider.allCases) { provider in
                        ConnectCloudButton(sync: sync, provider: provider, connected: { opened(sync) }) {
                            Label("Connect \(provider.label)", systemImage: provider == .dropbox ? "shippingbox" : "externaldrive")
                        }
                    }
                } footer: {
                    Text("Choose the cloud you connected on the website. Your record comes in from there, and your plan is ready.")
                }
                if notOpened {
                    Section {
                        Text("Signed in, but your record could not be opened yet. Check your connection, then try again.")
                            .foregroundStyle(.secondary)
                        Button("Try again") {
                            Task {
                                await sync.foreground()
                                opened(sync)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Your record")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { choosingCloud = false } }
            }
        }
        .presentationDetents([.medium])
    }

    /// "Get started" after a cloud sign-in whose record did not open would run the
    /// questions on the empty phone record, whose answers later win the merge
    /// (re-check R4): with a cloud connected, it goes the connect way instead.
    private func getStarted() {
        if let sync, sync.provider != nil {
            choosingCloud = true
            opened(sync)
        } else {
            start()
        }
    }

    /// Goes on only once the cloud record is open: a connect can sign in and still fail
    /// to read the record, and the questions must never start from the empty phone record
    /// (their answers would later win the merge over the website's; review R4).
    private func opened(_ sync: CloudSync) {
        guard sync.recordOpen else {
            notOpened = true
            return
        }
        notOpened = false
        choosingCloud = false
        connected()
    }

    private func point(_ symbol: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 16) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(.tint)
                .frame(width: 32)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline)
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview { WelcomeView(sync: nil, start: {}) }
