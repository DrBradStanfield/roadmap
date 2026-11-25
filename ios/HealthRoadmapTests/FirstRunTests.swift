import XCTest
@testable import HealthRoadmap

/// US-25 AC10, US-54, US-57 AC8 (iPhone survey S9, S16): the first-run cover and the backup
/// offer are each one named state, changed only by their `transition`. Every state x every
/// event names what follows; finishing runs once; the keys decide a launch as they always did.
final class FirstRunTests: XCTestCase {
    private typealias Event = Cover.Event

    private func check(_ got: (Cover, Cover.Effect?), _ cover: Cover, _ effect: Cover.Effect?, _ message: String = "",
                       file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(got.0, cover, message, file: file, line: line)
        XCTAssertEqual(got.1, effect, "\(message): effect", file: file, line: line)
    }

    private let events: [(String, Event)] = [
        ("launched", .launched(.init(welcomed: true, onboarded: true))),
        ("started needs", .started(needs: true)),
        ("started full", .started(needs: false)),
        ("connected needs", .connected(needs: true)),
        ("connected full", .connected(needs: false)),
        ("started unread", .started(needs: nil)),
        ("connected unread", .connected(needs: nil)),
        ("finished", .finished),
        ("erased", .erased),
    ]

    /// Every cover x every event. Unlisted pairs keep the cover and run nothing.
    func testEveryCoverAndEvent_US54() {
        let erased: (Cover, Cover.Effect?) = (.questions(.afterErase), .startOver)
        let table: [(Cover, [String: (Cover, Cover.Effect?)])] = [
            (.deciding, ["launched": (.none, nil)]),
            (.welcome, [
                "started needs": (.questions(.fresh), nil),
                // S34: a full record finishes at Start, as it does at connected.
                "started full": (.none, .finish),
                "connected needs": (.questions(.onlyMissing), nil),
                "connected full": (.none, .finish),
                // S42: an unread record closes the cover unfinished, so the next launch decides.
                "started unread": (.none, nil),
                "connected unread": (.none, nil),
            ]),
            (.questions(.fresh), ["finished": (.none, .finish)]),
            (.questions(.onlyMissing), ["finished": (.none, .finish)]),
            (.questions(.afterErase), ["finished": (.none, .finish)]),
            (.none, ["erased": erased]),
        ]
        for (cover, listed) in table {
            for (name, event) in events {
                let (next, effect) = Cover.transition(cover, event)
                let want = listed[name] ?? (cover, nil)
                XCTAssertEqual(next, want.0, "\(cover) x \(name)")
                XCTAssertEqual(effect, want.1, "\(cover) x \(name): effect")
            }
        }
    }

    /// Launch's five branches, decided once: a second launched event changes nothing.
    func testLaunchDecidesOnce_US54_AC7() {
        func launch(_ l: Cover.Launch) -> (Cover, Cover.Effect?) { Cover.transition(.deciding, .launched(l)) }
        check(launch(.init(welcomed: false, needsQuestions: true)), .welcome, nil, "a first launch welcomes")
        check(launch(.init(welcomed: true, onboarded: true, erasedElsewhere: true)), .questions(.afterErase), .startOver, "an erase on another device brings the questions back")
        check(launch(.init(welcomed: true, needsQuestions: true, run: .onlyMissing)), .questions(.onlyMissing), nil, "a relaunch mid-run resumes it the same way")
        check(launch(.init(welcomed: true, onboarded: true)), .none, nil, "a finished phone opens on the tabs")
        // Not onboarded and not erased elsewhere counts: only a finished phone starts over. A full
        // record past the welcome screen that never finished finishes now (S42).
        check(launch(.init(welcomed: true, erasedElsewhere: true)), .none, .finish)
        check(launch(.init(welcomed: true, needsQuestions: false)), .none, .finish, "welcomed, a full record, never finished: finish now (S34, S42)")
        check(launch(.init(welcomed: true, needsQuestions: nil)), .none, nil, "an unread record: no finish, the next launch decides (S42)")
        check(launch(.init(welcomed: true, onboarded: true, needsQuestions: nil)), .none, nil, "a finished phone with an unread record opens on the tabs")
        for cover in [Cover.welcome, .questions(.fresh), .none] {
            check(Cover.transition(cover, .launched(.init())), cover, nil, "\(cover): launch decides once")
        }
    }

    /// S9's reason: two finishes (the questions' end and a late no-Health arm, say) run
    /// RootView's finish effects (takeCount, ignoreSaves, the tour start) once.
    func testTwoFinishesFinishOnce_US54() {
        for start in [Cover.questions(.fresh), .welcome] {
            var cover = start
            var effects: [Cover.Effect?] = []
            for event in [start == .welcome ? Event.connected(needs: false) : .finished, .finished, .connected(needs: false), .started(needs: false)] {
                let (next, effect) = Cover.transition(cover, event)
                cover = next
                effects.append(effect)
            }
            XCTAssertEqual(cover, .none)
            XCTAssertEqual(effects.compactMap { $0 }, [.finish], "\(start): finished once")
        }
    }

    // MARK: Offer (US-57 AC8)

    /// Every offer x every event: 16 rows. Back up opens Sync only once the prompt has closed.
    func testEveryOfferAndEvent_US57_AC8() {
        let all: [Offer] = [.idle, .offering(backUp: false), .offering(backUp: true), .sync]
        let listed: [Offer: [Offer.Event: Offer]] = [
            .idle: [.due: .offering(backUp: false)],
            .offering(backUp: false): [.backUpTapped: .offering(backUp: true), .promptClosed: .idle],
            .offering(backUp: true): [.promptClosed: .sync],
            .sync: [.syncClosed: .idle],
        ]
        for offer in all {
            for event in [Offer.Event.due, .backUpTapped, .promptClosed, .syncClosed] {
                XCTAssertEqual(Offer.transition(offer, event), listed[offer]?[event] ?? offer, "\(offer) x \(event)")
            }
        }
        XCTAssertTrue(Offer.offering(backUp: false).prompting)
        XCTAssertFalse(Offer.offering(backUp: true).prompting, "Back up closes the prompt")
    }

    /// Every cover x offer x hold x erase x count (S48). Only over the bare tabs with no hold from
    /// this phone's own erase: an erase from elsewhere raises the questions with no offer up, and
    /// closes the backup prompt or Sync sheet first from every other offer state; with no erase,
    /// a record not yet counted is counted, whatever the offer.
    func testAnEraseClosesTheOfferFirst_US25_AC16d() {
        let covers: [Cover] = [.deciding, .welcome, .questions(.fresh), .questions(.onlyMissing), .questions(.afterErase), .none]
        let offers: [Offer] = [.idle, .offering(backUp: false), .offering(backUp: true), .sync]
        for cover in covers {
            for offer in offers {
                for holding in [false, true] {
                    for erased in [false, true] {
                        for uncounted in [false, true] {
                            var want: Cover.RecordChange?
                            if cover == .none, !holding {
                                want = erased ? (offer == .idle ? .erase : .closeOffer) : uncounted ? .takeCount : nil
                            }
                            let got = Cover.onRecordChange(cover: cover, offer: offer, holding: holding, erasedElsewhere: erased, uncounted: uncounted)
                            XCTAssertEqual(got, want, "\(cover) x \(offer) x holding \(holding) x erased \(erased) x uncounted \(uncounted)")
                        }
                    }
                }
            }
        }
        // closeOffer's two events land idle from every offer state (RootView.recordChanged).
        for offer in offers {
            XCTAssertEqual([Offer.Event.promptClosed, .syncClosed].reduce(offer, Offer.transition), .idle, "\(offer)")
        }
    }

    /// A local-only phone whose Sync sheet is open after the backup prompt's Back up. Moved only
    /// as RootView moves it: `recordChanged` reads the record and the keys the way RootView's
    /// erasedElsewhere and recordChanged do, then acts on Cover.onRecordChange; `sheetGone` is
    /// the sheets' onDismiss.
    private struct Phone {
        static let full = MyData.Profile(sex: "female", birthYear: 1980, birthMonth: nil, height: "170", heightUnit: "cm", feetInches: nil)
        static let erasedProfile = MyData.Profile(sex: nil, birthYear: nil, birthMonth: nil, height: nil, heightUnit: "cm", feetInches: nil)

        var cover = Cover.none
        var offer = [Offer.Event.due, .backUpTapped, .promptClosed].reduce(Offer.idle, Offer.transition)
        var counted = (epoch: 0, source: "")
        /// `open`: ShownRecord.open, the source's own record drawn (S72, S73).
        var source = "", open = true, epoch = 0, profile = full

        mutating func recordChanged() {
            let erased = source == counted.source && OnboardingSteps.erasedSince(counted.epoch, epoch: epoch, profile: profile)
            let uncounted = source != counted.source && open
            switch Cover.onRecordChange(cover: cover, offer: offer, holding: false, erasedElsewhere: erased, uncounted: uncounted) {
            case .erase?: cover = Cover.transition(cover, .erased).0
            case .closeOffer?: offer = [.promptClosed, .syncClosed].reduce(offer, Offer.transition)
            case .takeCount?: counted = (epoch, source)
            case nil: break
            }
        }

        /// RootView.finished's takeCount: only the open record of its own source counts (S43, S73).
        mutating func finish() { if open { counted = (epoch, source) } }
        /// Sends `event` as RootView.send does: a finish effect runs finish().
        mutating func send(_ event: Cover.Event) {
            let (next, effect) = Cover.transition(cover, event)
            cover = next
            if effect == .finish { finish() }
        }

        mutating func sheetGone() { recordChanged() }
        /// Sync's Connect opens a cloud record whose erase count is 2.
        mutating func connect() { (source, open, epoch) = ("dropbox", true, 2); recordChanged() }
        /// The website erases; the next pull lands it.
        mutating func erasedOnTheWebsite() { (epoch, profile) = (3, Self.erasedProfile); recordChanged() }
        /// Disconnect copies the cloud record down to the phone. The source turns local while the
        /// cloud's record is still drawn, then the phone's copy lands at the same count (S73).
        mutating func disconnect() {
            (source, open) = ("", false); recordChanged()
            open = true; recordChanged()
        }
        /// Sync's Done, or a swipe: the binding closes it, then onDismiss.
        mutating func done() { offer = Offer.transition(offer, .syncClosed); sheetGone() }
    }

    /// (i) Connect, an erase from the website, Disconnect, Done: the erase closes Sync at once,
    /// so the questions rise before a Disconnect could hide it, and stay.
    func testConnectEraseDisconnectRaisesTheQuestions_US25_AC16d() {
        var phone = Phone()
        XCTAssertEqual(phone.offer, .sync)
        phone.connect()
        phone.erasedOnTheWebsite()
        XCTAssertEqual(phone.offer, .idle, "the erase closes Sync")
        phone.sheetGone()
        XCTAssertEqual(phone.cover, .questions(.afterErase))
        phone.disconnect()
        phone.done()
        XCTAssertEqual(phone.cover, .questions(.afterErase), "a later Disconnect never hides the erase")
    }

    /// (ii) A plain connect, then Done: the cloud's count is taken, so no erase is seen later:
    /// not at Done, a later pull or a Disconnect.
    func testAPlainConnectTakesTheCloudsCount_US25_AC16d() {
        var phone = Phone()
        phone.connect()
        XCTAssertEqual(phone.counted.epoch, 2)
        XCTAssertEqual(phone.counted.source, "dropbox")
        phone.done()
        phone.recordChanged()
        phone.disconnect()
        XCTAssertEqual(phone.cover, .none, "no false erase")
        XCTAssertEqual(phone.offer, .idle)
    }

    /// (iii) Connect, an erase from the website, Done with no Disconnect: the questions rise.
    func testConnectEraseDoneRaisesTheQuestions_US25_AC16d() {
        var phone = Phone()
        phone.connect()
        phone.erasedOnTheWebsite()
        phone.done()
        XCTAssertEqual(phone.cover, .questions(.afterErase))
    }

    // MARK: The count at a finish (S43)

    /// RootView's render path (lead S72): its key is ShownRecord's fields, and `onChange(of:
    /// shownRecord)` runs recordChanged only when the key changes. `shown` is the connection's
    /// session, `drawn` the store's, `phoneDrawn` the store on the phone's record. `.countOnly`
    /// mirrors the rejected fix: countable reads the draw, but the key's open is still
    /// sync.recordOpen (`shown != nil`), with no draw in it. `.old` is main before S72: the key
    /// reads sync.recordOpen, and countable is `source.isEmpty || recordOpen`.
    private struct Render {
        enum Variant { case fixed, countOnly, old }
        var source = "", shown: Int? = nil, drawn: Int? = nil, phoneDrawn = true, epoch = 0
        var counted = (epoch: 0, source: "")
        let variant: Variant
        private var key: [String]

        init(_ variant: Variant = .fixed) {
            self.variant = variant
            key = []
            key = currentKey
        }

        private var drawnOpen: Bool { ShownRecord.open(source: source, shown: shown, drawn: drawn, phoneDrawn: phoneDrawn) }
        private var keyOpen: Bool { variant == .fixed ? drawnOpen : shown != nil }
        private var countOpen: Bool { variant == .old ? source.isEmpty || shown != nil : drawnOpen }
        private var currentKey: [String] { [source, "\(keyOpen)", "\(epoch)"] }

        mutating func render() {
            guard currentKey != key else { return }
            key = currentKey
            if source != counted.source { finish() }
        }

        /// RootView.finished's takeCount (and recordChanged's, once uncounted).
        mutating func finish() { if countOpen { counted = (epoch, source) } }

        /// Signed in to Dropbox, the session opens, then its record is drawn at `cloudEpoch`;
        /// a render after each step. The phone's copy is at epoch 0.
        mutating func connect(cloudEpoch: Int, check: (Render) -> Void = { _ in }) {
            source = "dropbox"; render(); check(self)
            shown = 7; render(); check(self) // CloudSync's .opened: the draw has not landed
            (drawn, phoneDrawn, epoch) = (7, false, cloudEpoch); render()
        }

        /// Disconnect (CloudSync.disconnect): `.disconnectEnded` turns the source local and closes
        /// the session while the store still draws the cloud's record (`window`, a render there),
        /// then showPhone lands the phone's copy at `phoneEpoch`.
        mutating func disconnect(phoneEpoch: Int, window: (Render) -> Void = { _ in }) {
            (source, shown) = ("", nil); render(); window(self)
            (drawn, phoneDrawn, epoch) = (nil, true, phoneEpoch); render()
        }
    }

    /// S72: a connect counts nothing until the cloud's record is drawn, not at a render or a finish
    /// in the gap, then takes the cloud's count. Main before S72 counted the phone's copy there.
    func testAConnectCountsTheCloudOnlyOnceItsRecordIsDrawn_US54_AC7() {
        var phone = Render()
        phone.connect(cloudEpoch: 2) { step in
            XCTAssertEqual(step.counted.source, "", "the phone's copy is never counted under Dropbox's name")
            XCTAssertEqual(step.counted.epoch, 0)
            var finished = step
            finished.finish() // the questions finish in the gap
            XCTAssertEqual(finished.counted.source, "", "a finish before the draw takes nothing")
        }
        XCTAssertEqual(phone.counted.epoch, 2, "the cloud's count")
        XCTAssertEqual(phone.counted.source, "dropbox")

        var old = Render(.old)
        old.connect(cloudEpoch: 2)
        XCTAssertEqual(old.counted.epoch, 0, "main counted the phone's copy at the open")
        XCTAssertEqual(old.counted.source, "dropbox")
    }

    /// S72: the cloud's epoch equals the phone copy's. The key still changes at the draw, so the
    /// count is taken. With the countable-only fix the key changes at the open, when nothing is
    /// countable, and not at the draw, so the draw takes nothing.
    func testAConnectAtAnEqualEpochStillTakesTheCount_US54_AC7() {
        var phone = Render()
        phone.connect(cloudEpoch: 0)
        XCTAssertEqual(phone.counted.epoch, 0)
        XCTAssertEqual(phone.counted.source, "dropbox", "the draw takes the count")

        var countOnly = Render(.countOnly)
        countOnly.connect(cloudEpoch: 0)
        XCTAssertEqual(countOnly.counted.source, "", "the rejected fix takes nothing at the draw")
    }

    /// S73: a Disconnect counts nothing while the cloud's record is still drawn under the phone's
    /// name, not at a render or a finish in the window, then takes the phone's own count when it
    /// lands. Main before S73 took the cloud's count under "" in the window.
    func testADisconnectCountsThePhoneOnlyOnceItsRecordIsDrawn_US54_AC7() {
        var phone = Render()
        phone.connect(cloudEpoch: 2)
        phone.disconnect(phoneEpoch: 3) { step in
            XCTAssertEqual(step.counted.source, "dropbox", "the cloud's record is never counted under the phone's name")
            XCTAssertEqual(step.counted.epoch, 2)
            var finished = step
            finished.finish() // the questions finish in the window
            XCTAssertEqual(finished.counted.source, "dropbox", "a finish before the land takes nothing")
        }
        XCTAssertEqual(phone.counted.epoch, 3, "the phone's count")
        XCTAssertEqual(phone.counted.source, "")

        var old = Render(.old)
        old.connect(cloudEpoch: 2)
        old.disconnect(phoneEpoch: 3) { step in
            XCTAssertEqual(step.counted.epoch, 2, "main took the cloud's count in the window")
            XCTAssertEqual(step.counted.source, "")
        }
        XCTAssertEqual(old.counted.epoch, 2, "and kept it past the land")
    }

    /// S73: the phone's copy lands at the cloud's epoch, as after a copy-down. The key still changes
    /// at the land (open flips), so the count is taken. Without the draw in the key, the window is
    /// the only change and counts nothing, and the land takes nothing either.
    func testADisconnectAtAnEqualEpochStillTakesThePhonesCount_US54_AC7() {
        var phone = Render()
        phone.connect(cloudEpoch: 2)
        phone.disconnect(phoneEpoch: 2)
        XCTAssertEqual(phone.counted.epoch, 2)
        XCTAssertEqual(phone.counted.source, "", "the land takes the count")

        var countOnly = Render(.countOnly)
        countOnly.connect(cloudEpoch: 2)
        countOnly.disconnect(phoneEpoch: 2)
        XCTAssertEqual(countOnly.counted.source, "dropbox", "without the flag in the key the land takes nothing")
    }

    /// A phone past the welcome screen with a full record, never finished, connected to Dropbox
    /// whose record has not opened at launch: the phone's copy says erase count 0, the cloud's 2.
    private func launchedBeforeTheCloudOpens() -> Phone {
        var phone = Phone()
        phone.offer = .idle
        phone.cover = .deciding
        (phone.source, phone.open, phone.epoch) = ("dropbox", false, 0)
        phone.send(.launched(.init(welcomed: true, onboarded: false, needsQuestions: false)))
        return phone
    }

    /// S43: the launch finish leaves the count untaken; the cloud opening takes the cloud's.
    func testALaunchFinishBeforeTheCloudOpensCountsTheCloudOnceOpen_US54_AC7() {
        var phone = launchedBeforeTheCloudOpens()
        XCTAssertEqual(phone.cover, .none, "the launch finished")
        XCTAssertEqual(phone.counted.source, "", "the phone's copy is not counted under Dropbox's name")
        XCTAssertEqual(phone.counted.epoch, 0)
        (phone.open, phone.epoch) = (true, 2)
        let uncounted = phone.source != phone.counted.source && phone.open
        XCTAssertEqual(Cover.onRecordChange(cover: phone.cover, offer: phone.offer, holding: false, erasedElsewhere: false, uncounted: uncounted),
                       .takeCount, "the opening finds the record uncounted")
        phone.recordChanged()
        XCTAssertEqual(phone.counted.epoch, 2, "the cloud's count")
        XCTAssertEqual(phone.counted.source, "dropbox")
    }

    /// The reason: with the cloud's count taken, a cloud profile lacking an answer at that same
    /// count never brings back the after-erase questions.
    func testALaunchFinishBeforeTheCloudOpensNeverAsksAgainAtTheSameCount_US54_AC7() {
        var phone = launchedBeforeTheCloudOpens()
        (phone.open, phone.epoch, phone.profile) = (true, 2, Phone.erasedProfile)
        phone.recordChanged()
        phone.recordChanged()
        XCTAssertEqual(phone.cover, .none, "no false erase")
    }

    /// A local-only launch finish takes the phone's count, as before.
    func testALocalLaunchFinishTakesThePhonesCount_US54_AC7() {
        var phone = Phone()
        (phone.offer, phone.cover, phone.source, phone.open, phone.epoch) = (.idle, .deciding, "", true, 1)
        phone.counted = (0, "dropbox")
        phone.send(.launched(.init(welcomed: true, onboarded: false, needsQuestions: false)))
        XCTAssertEqual(phone.counted.epoch, 1)
        XCTAssertEqual(phone.counted.source, "")
    }

    /// The questions' own finish follows the same rule: untaken before the cloud opens, the
    /// cloud's count once open; taken at once when the cloud is already open.
    func testTheQuestionsFinishFollowsTheSameRule_US54_AC7() {
        var phone = Phone()
        (phone.offer, phone.cover, phone.source, phone.open, phone.epoch) = (.idle, .questions(.fresh), "dropbox", false, 0)
        phone.send(.finished)
        XCTAssertEqual(phone.cover, .none)
        XCTAssertEqual(phone.counted.source, "", "untaken before the cloud opens")
        (phone.open, phone.epoch) = (true, 2)
        phone.recordChanged()
        XCTAssertEqual(phone.counted.epoch, 2)
        XCTAssertEqual(phone.counted.source, "dropbox")

        var open = Phone()
        (open.offer, open.cover, open.source, open.open, open.epoch) = (.idle, .questions(.onlyMissing), "dropbox", true, 2)
        open.send(.finished)
        XCTAssertEqual(open.counted.epoch, 2, "an open cloud counts at the finish")
        XCTAssertEqual(open.counted.source, "dropbox")
    }

    /// Not now: the binding's close, then onDismiss's, land idle once; Back up: Sync after the prompt.
    func testPromptClosesOnceEitherWay_US57_AC8() {
        let notNow = [Offer.Event.due, .promptClosed, .promptClosed].reduce(Offer.idle, Offer.transition)
        XCTAssertEqual(notNow, .idle)
        let backUp = [Offer.Event.due, .backUpTapped, .promptClosed].reduce(Offer.idle, Offer.transition)
        XCTAssertEqual(backUp, .sync)
        XCTAssertEqual(Offer.transition(backUp, .syncClosed), .idle)
    }

    // MARK: Keys

    private static func keys(_ seed: [String: Any] = [:]) -> FirstRunKeys {
        let defaults = UserDefaults(suiteName: "FirstRunTests-\(UUID().uuidString)")!
        seed.forEach { defaults.set($1, forKey: $0) }
        return FirstRunKeys(defaults: defaults)
    }

    private func decide(_ keys: FirstRunKeys, needsFlow: Bool?, erasedElsewhere: Bool = false) -> (Cover, Cover.Effect?) {
        Cover.transition(.deciding, .launched(keys.launch(needsFlow: needsFlow, erasedElsewhere: erasedElsewhere)))
    }

    /// Six seeded installs decide the same cover as before the union: no key changed name or meaning.
    func testSeededInstallsDecideAsBefore_US54_AC7() {
        check(decide(Self.keys(), needsFlow: true), .welcome, nil, "fresh install")
        check(decide(Self.keys(["welcomed": true, "onboardingHealthAsked": true]), needsFlow: false), .questions(.fresh), nil, "mid-run, quit at weight with sex, birth and height saved")
        check(decide(Self.keys(["welcomed": true, "onboardingOnlyMissing": true]), needsFlow: true), .questions(.onlyMissing), nil, "mid-run after I already use Health Roadmap")
        check(decide(Self.keys(["welcomed": true, "onboardingAfterErase": true]), needsFlow: true), .questions(.afterErase), nil, "mid-run after Delete all my data")
        check(decide(Self.keys(["welcomed": true, "onboarded": true, "onboardingHealthAsked": true]), needsFlow: true), .none, nil, "onboarded: never asked again")
        check(decide(Self.keys(["welcomed": true, "onboarded": true]), needsFlow: true, erasedElsewhere: true), .questions(.afterErase), .startOver, "onboarded, erased on another device")
    }

    /// S9 fault 2: finishing forgets the run, so `onboarded` never sits beside a run begun.
    func testFinishClearsTheRunFlags_US54() {
        let keys = Self.keys(["welcomed": true, "onboardingHealthAsked": true, "onboardingOnlyMissing": true,
                              "onboardingFromHealth": "sex", "onboardingAfterErase": true])
        keys.persist(.none, .finish)
        XCTAssertTrue(keys.onboarded)
        XCTAssertTrue(keys.welcomed)
        for key in ["onboardingHealthAsked", "onboardingOnlyMissing", "onboardingAfterErase"] {
            XCTAssertFalse(keys.defaults.bool(forKey: key), key)
        }
        XCTAssertEqual(keys.defaults.string(forKey: "onboardingFromHealth"), "")
    }

    /// "Delete all my data": the questions again, after an erase, with nothing of the old run.
    func testStartOverWritesTheErasedRun_US54_AC7() {
        let keys = Self.keys(["welcomed": true, "onboarded": true, "onboardingHealthAsked": true, "onboardingOnlyMissing": true,
                              "onboardingFromHealth": "sex"])
        let (cover, effect) = Cover.transition(.none, .erased)
        keys.persist(cover, effect)
        XCTAssertFalse(keys.onboarded)
        XCTAssertTrue(keys.welcomed, "not the welcome screen")
        XCTAssertFalse(keys.defaults.bool(forKey: "onboardingHealthAsked"))
        XCTAssertFalse(keys.defaults.bool(forKey: "onboardingOnlyMissing"))
        XCTAssertTrue(keys.defaults.bool(forKey: "onboardingAfterErase"))
        XCTAssertEqual(keys.defaults.string(forKey: "onboardingFromHealth"), "")
        check(decide(keys, needsFlow: true), .questions(.afterErase), nil, "a relaunch resumes the erased run")
    }

    /// S34: Welcome's Start on a full phone record finishes, so `onboarded` is set and the
    /// person's saves count toward the backup offer (RootView's ownSaves guard).
    func testWelcomeStartWithAFullRecordFinishes_US57_AC9() {
        let keys = Self.keys()
        XCTAssertEqual(keys.needsQuestions(needsFlow: false), false)
        XCTAssertNil(keys.needsQuestions(needsFlow: nil), "an unread record cannot say")
        let (cover, effect) = Cover.transition(.welcome, .started(needs: keys.needsQuestions(needsFlow: false)))
        keys.persist(cover, effect)
        XCTAssertEqual(effect, .finish)
        XCTAssertTrue(keys.onboarded, "saves now count")
        check(decide(keys, needsFlow: false), .none, nil, "a relaunch opens on the tabs")
    }

    /// S42: Start while the record is unread is past the welcome screen but not a finish.
    func testWelcomeStartWithAnUnreadRecordLeavesOnboardedFalse_US57_AC9() {
        let keys = Self.keys()
        let (cover, effect) = Cover.transition(.welcome, .started(needs: nil))
        keys.persist(cover, effect)
        XCTAssertTrue(keys.welcomed)
        XCTAssertFalse(keys.onboarded, "not finished: the next launch decides again")
    }

    /// S42: Start while the record is unread, then a relaunch with a readable record that lacks
    /// height: the questions come, where a finish at Start would have skipped them for good.
    func testAnUnreadStartThenARecordLackingHeightBringsTheQuestions_US57_AC9() {
        let keys = Self.keys()
        let (cover, effect) = Cover.transition(.welcome, .started(needs: nil))
        keys.persist(cover, effect)
        let profile = MyData.Profile(sex: "female", birthYear: 1980, birthMonth: 6, height: nil, heightUnit: "cm", feetInches: nil)
        XCTAssertTrue(OnboardingSteps.needsFlow(profile), "a record without height needs the questions")
        check(decide(keys, needsFlow: OnboardingSteps.needsFlow(profile)), .questions(.fresh), nil)
    }

    /// S42: Start while the record is unread, then a relaunch with a full record: it finishes at
    /// launch, so `onboarded` is set and saves count. The launch after decides the tabs with no
    /// effect, so finish never runs twice. A relaunch still unread finishes nothing.
    func testAnUnreadStartThenAFullRecordFinishesAtTheNextLaunchOnce_US57_AC9() {
        let keys = Self.keys()
        let (cover, effect) = Cover.transition(.welcome, .started(needs: nil))
        keys.persist(cover, effect)
        check(decide(keys, needsFlow: nil), .none, nil, "still unread: decide again next launch")
        XCTAssertFalse(keys.onboarded)
        let relaunch = decide(keys, needsFlow: false)
        check(relaunch, .none, .finish, "a full record finishes once read")
        keys.persist(relaunch.0, relaunch.1)
        XCTAssertTrue(keys.onboarded, "saves now count")
        check(decide(keys, needsFlow: false), .none, nil, "the launch after: no second finish")
    }

    /// F6: a launch mid-questions with the record unread shows the tabs, unfinished. Before PR 1608
    /// it resumed the questions, which finished at once on an unread record (accepted change).
    func testAMidRunLaunchWithAnUnreadRecordDecidesNothing_US57_AC9() {
        let keys = Self.keys(["welcomed": true, "onboardingHealthAsked": true])
        check(decide(keys, needsFlow: nil), .none, nil, "unread: no questions, no finish; the next launch decides")
        XCTAssertFalse(keys.onboarded)
    }

    /// Entering a run writes why it runs, and the welcome screen is done.
    func testEnteringARunWritesItsPair_US54() {
        let keys = Self.keys()
        keys.persist(.questions(.onlyMissing), nil)
        XCTAssertTrue(keys.welcomed)
        XCTAssertTrue(keys.defaults.bool(forKey: "onboardingOnlyMissing"))
        XCTAssertFalse(keys.defaults.bool(forKey: "onboardingAfterErase"))
        XCTAssertFalse(keys.onboarded, "a run is not a finish")
        keys.persist(.welcome, nil)
        XCTAssertTrue(keys.defaults.bool(forKey: "onboardingOnlyMissing"), "the welcome screen writes nothing")
    }
}
