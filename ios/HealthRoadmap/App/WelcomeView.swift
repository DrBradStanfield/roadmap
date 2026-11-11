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
    /// A connect error from the sheet: held here, since its row can hide mid-sign-in (US-25 AC11j).
    @State private var connectMessage: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The size the story's scenes need (WelcomeStory.needs), and the width they get. Unknown
    /// until measured, so the first frame shows the words, never a cut story.
    @State private var storyNeeds = CGSize(width: CGFloat.infinity, height: .infinity)
    @State private var width = CGFloat.zero

    /// The story shows only where every scene fits its card whole; elsewhere (larger text, a
    /// narrow phone) its words scroll above the buttons, which stay on screen (US-54 AC8b).
    private var showsStory: Bool {
        storyNeeds.width <= width && storyNeeds.height <= WelcomeStory.height
    }

    /// Read from the cloud each time, never kept here (US-54 AC2b).
    private var phase: WelcomeConnect.Phase {
        guard let sync else { return .choosing }
        return WelcomeConnect.phase(provider: sync.provider, status: sync.status, recordOpen: sync.recordOpen)
    }

    var body: some View {
        VStack(spacing: 0) {
            if showsStory {
                Spacer(minLength: 12)
                heading
                Spacer(minLength: 16)
                // What the app does and where the data lives, told as a story (Brad 2026-10-23).
                WelcomeStory()
                    .opacity(shown ? 1 : 0)
                    .offset(y: shown || reduceMotion ? 0 : 20)
                Spacer(minLength: 16)
                disclaimer
            } else {
                ScrollView {
                    VStack(spacing: 16) {
                        heading
                        Text(WelcomeStory.summary).font(.body).multilineTextAlignment(.center)
                            .opacity(shown ? 1 : 0)
                        disclaimer
                    }
                    .padding(.top, 12)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
            Button("Get started") { apply(.getStarted) }
            .buttonStyle(.accent)
            .padding(.top, 16)
            .accessibilityIdentifier("welcome.start")
            if sync != nil {
                Button("I already use Health Roadmap") { apply(.existing) }
                    .padding(.top, 10)
                    .accessibilityIdentifier("welcome.existing")
            }
        }
        .background(alignment: .topLeading) {
            WelcomeStory.needs.hidden().onGeometryChange(for: CGSize.self) { $0.size } action: { storyNeeds = $0 }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onChange(of: phase) { apply(.phaseChanged) }
        .onChange(of: connectMessage) { old, new in if old != nil, new == nil { apply(.alertDismissed) } }
        // A connect error that lands after the person left the sheet never shows later, out of
        // context: cleared as the sheet opens or closes. With the sheet closed its alertDismissed
        // decides nothing; on opening the record is not open yet (US-25 AC11j).
        .onChange(of: choosingCloud) { connectMessage = nil }
        .sheet(isPresented: $choosingCloud) {
            if let sync { cloudChooser(sync) }
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 12)
        .onAppear {
            withAnimation(.spring(duration: 0.8, bounce: 0.35)) { shown = true }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: shown && !reduceMotion)
    }

    private var heading: some View {
        VStack(spacing: 0) {
            hero
                .scaleEffect(shown || reduceMotion ? 1 : 0.6)
                .opacity(shown ? 1 : 0)
            Text("Your health roadmap")
                .font(.largeTitle.bold())
                .multilineTextAlignment(.center)
                .padding(.top, 20)
            Text("By Dr Brad Stanfield")
                .font(.headline)
                .foregroundStyle(.secondary)
                .padding(.top, 4)
        }
    }

    private var disclaimer: some View {
        Text("For education only, not medical advice. Talk to your doctor before you change anything about your health or medicines.")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
    }

    /// The app icon's mark: a road that ends at a heart.
    private var hero: some View {
        LogoMark(bounce: shown && !reduceMotion)
            .accessibilityHidden(true)
    }

    /// Where the website keeps the record: Sync's own connect buttons (US-25 AC11).
    private func cloudChooser(_ sync: CloudSync) -> some View {
        NavigationStack {
            List {
                Section { SyncDiagram() }
                if WelcomeConnect.showsConnect(phase) {
                    Section {
                        ForEach(CloudProvider.allCases) { provider in
                            // The phase change goes on, once; the button's own callback does not.
                            ConnectCloudButton(sync: sync, provider: provider, message: $connectMessage, connected: {}) {
                                Label("Connect \(provider.label)", systemImage: provider == .dropbox ? "shippingbox" : "externaldrive")
                            }
                        }
                    } footer: {
                        Text("Choose the cloud you connected on the website. Your record comes in from there, and your plan is ready.")
                    }
                }
                switch phase {
                case .opening: busy("Opening your record")
                case .disconnecting: busy("Disconnecting…")
                case .failed(let problem):
                    if let provider = sync.provider {
                        let failure = WelcomeConnect.failure(problem, provider: provider)
                        Section {
                            Text(failure.words).foregroundStyle(.secondary)
                            if failure.offersTryAgain { Button("Try again") { apply(.tryAgain) } }
                        }
                    }
                case .choosing, .opened:
                    EmptyView()
                }
                if WelcomeConnect.showsRecovery(phase), let provider = sync.provider {
                    Section {
                        ConnectCloudButton(sync: sync, provider: provider, message: $connectMessage, connected: {}) {
                            Label("Sign in to \(provider.label) again", systemImage: "person.badge.key")
                        }
                        Button("Use a different cloud") { apply(.useDifferentCloud) }
                    }
                }
            }
            .messageAlert("Your record", $connectMessage)
            .navigationTitle("Your record")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { choosingCloud = false } }
            }
        }
        .presentationDetents([.medium])
    }

    /// A spinner row and what it waits on.
    private func busy(_ words: LocalizedStringKey) -> some View {
        Section {
            HStack {
                ProgressView()
                Text(words).foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(words)
        }
    }

    /// "Get started" with a cloud connected waits on its record, so the questions never
    /// run on the empty phone record, whose answers would later win the merge (review
    /// R4). Every tap that can show the spinner starts an open (WelcomeConnect).
    private func apply(_ event: WelcomeConnect.Event) {
        switch WelcomeConnect.decide(event, phase: phase, sheetShown: choosingCloud, alertShown: connectMessage != nil) {
        case .start: start()
        case .goOn:
            choosingCloud = false
            connected()
        case .showSheet: choosingCloud = true
        case .showSheetAndOpen:
            choosingCloud = true
            openRecord()
        case .open: openRecord()
        case .disconnect:
            guard let sync, let provider = sync.provider else { return }
            Task { if await sync.disconnectOutcome() == .failed { connectMessage = SyncStatusText.disconnectFailed(provider) } }
        case .nothing: break
        }
    }

    /// CloudSync's open is single-flight: one already running is joined.
    private func openRecord() {
        guard let sync else { return }
        Task { await sync.foreground() }
    }
}

#Preview { WelcomeView(sync: nil, start: {}) }
