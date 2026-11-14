import XCTest
@testable import HealthRoadmap

/// US-67: the iPhone chat saves what I tell it, after I confirm. Swift only carries the
/// server's proposals and the engine's Undo; the engine reads, converts and writes them.
/// The engine's `chatEditsJson` and its two edit kinds are stood in here, so these tests
/// hold the app's half: what it sends, when it writes, and what an erase drops.
@MainActor
final class ChatEditsTests: XCTestCase {
    private var folder: URL!
    private var events: [Analytics.Event] = []

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Chat Edits \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        events = []
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    /// The engine with a stand-in preview door, and an edit door that keeps each chat edit it
    /// is sent (`__sent`) and writes a plain value in its place, so the record moves.
    private func engine() throws -> HealthEngine {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "health-engine", withExtension: "js"))
        let standIn = """
            HealthEngine = (function (e) {
              var o = Object.assign({}, e);
              globalThis.__sent = [];
              o.chatEditsJson = function (record, edits, now, device, today, units) {
                var list = JSON.parse(edits);
                if (list.some(function (x) { return x.boom; })) throw new Error('unreadable');
                var meds = list.filter(function (x) { return x.kind === 'medication'; });
                var rest = list.filter(function (x) { return x.kind !== 'medication'; });
                if (meds.some(function (x) { return x.refuseMeds; })) meds = [];
                return JSON.stringify({
                  medications: list.some(function (x) { return x.refuseMeds; }) ? { lines: [], undo: null, refusal: 'That medicine is not on the list, so nothing was saved.' } : meds.length ? { lines: [{ text: 'Statin: atorvastatin 20 mg' }], undo: meds.some(function (x) { return x.noUndo; }) ? null : { kind: 'chatUndo', medications: [1.5, null, true] }, refusal: null } : null,
                  review: rest.length ? {
                    lines: [{ text: 'Weight 80 kg', replaces: '82 kg' }, { text: 'Height 178 cm', replaces: null }],
                    refusal: list.some(function (x) { return x.refuse; }) ? 'That weight is outside the range the app can save.' : null,
                    seen: { revision: 'r1', at: [2, 0.5] }
                  } : null
                });
              };
              o.applyEditJson = function (record, edit, now, device, units) {
                var sent = JSON.parse(edit);
                if (sent.kind === 'chatEdits' || sent.kind === 'chatUndo') {
                  __sent.push(sent);
                  edit = JSON.stringify(sent.kind === 'chatUndo' ? { kind: 'add', metric: 'waist', value: 91, day: '2026-01-02' }
                    : sent.part === 'medications' ? { kind: 'add', metric: 'waist', value: 90, day: '2026-01-01' }
                    : { kind: 'add', metric: 'weight', value: 80, day: sent.today });
                }
                return e.applyEditJson(record, edit, now, device, units);
              };
              return o;
            })(HealthEngine);
            """
        return try HealthEngine(source: try String(contentsOf: url, encoding: .utf8) + "\n" + standIn, sourceURL: nil, session: StubHTTP.session())
    }

    private func setUpEdits() throws -> (RecordStore, ChatEdits, HealthEngine) {
        let engine = try engine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        let edits = ChatEdits(store: store)
        edits.send = { [weak self] in self?.events.append($0) }
        return (store, edits, engine)
    }

    private func sent(_ engine: HealthEngine) throws -> [NSDictionary] {
        let text = try engine.blocking { try $0.evaluate("JSON.stringify(__sent)").toString() } ?? "[]"
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [NSDictionary])
    }

    private func json(_ text: String) throws -> OpaqueJSON {
        try JSONDecoder().decode(OpaqueJSON.self, from: Data(text.utf8))
    }

    private let medication = #"[{"kind":"medication","medicationKey":"statin","drug":"atorvastatin","dose":20,"unit":"mg"}]"#
    private let values = #"[{"kind":"field","field":"weightKg","displayValue":80,"unitSystem":"si","date":null},{"kind":"profile","heightCm":178}]"#
    private let today = "2026-11-02"

    // MARK: AC1, AC2: the capability, and the proposals as they came

    func testTheBodyAsksForTheEditTools_US67_AC1() throws {
        let body = try ChatClient.body(message: "My weight is 80 kg", conversationId: "c1", history: [], contextJSON: #"{"unitSystem":"si"}"#)
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(sent["edits"] as? Int, 1)
        XCTAssertNotNil(sent["guestInputs"] as? [String: Any], "the app's inputs stand in for the web's guestInputs")
    }

    func testProposedEditsAreKeptAsTheyCame_US67_AC2() throws {
        let proposals = #"[{"kind":"field","field":"ldlC","displayValue":4.1,"unitSystem":"si","date":null},{"kind":"profile","sex":"male","heightCm":178}]"#
        let expected = try JSONSerialization.jsonObject(with: Data(proposals.utf8)) as? NSArray
        // The streamed `done` line and the one JSON reply (CHAT_STREAMING=false) alike.
        for line in [#"{"type":"done","success":true,"content":"Ready to save","isFallback":false,"proposedEdits":\#(proposals)}"#,
                     #"{"success":true,"content":"Ready to save","isFallback":false,"proposedEdits":\#(proposals)}"#] {
            guard case .done(let content, _, nil, let edits?) = ChatStreamEvent.parse(line) else { return XCTFail(line) }
            XCTAssertEqual(content, "Ready to save")
            XCTAssertEqual(try JSONSerialization.jsonObject(with: Data(edits.text.utf8)) as? NSArray, expected, "passed on unread, numbers and nulls kept")
        }
        // A reply without edits, with an empty list, or a failed one carries none.
        XCTAssertEqual(ChatStreamEvent.parse(#"{"type":"done","success":true,"content":"Hi","isFallback":false}"#), .done(content: "Hi", isFallback: false, error: nil, edits: nil))
        XCTAssertEqual(ChatStreamEvent.parse(#"{"type":"done","success":true,"content":"Hi","isFallback":false,"proposedEdits":[]}"#), .done(content: "Hi", isFallback: false, error: nil, edits: nil))
        XCTAssertEqual(ChatStreamEvent.parse(#"{"type":"done","success":false,"error":"Failed","proposedEdits":\#(proposals)}"#), .done(content: nil, isFallback: false, error: "Failed", edits: nil))
    }

    func testTheEditsReachTheEngineAsTheyCame_US67_AC4() throws {
        let edits = try json(values)
        let chat = try JSONEncoder().encode(RecordEdit.chatEdits(part: .review, edits: edits, today: today))
        XCTAssertEqual(try JSONSerialization.jsonObject(with: chat) as? NSDictionary, [
            "kind": "chatEdits", "part": "review", "today": today,
            "edits": try JSONSerialization.jsonObject(with: Data(values.utf8)),
        ] as NSDictionary)
        let withSeen = try JSONEncoder().encode(RecordEdit.chatEdits(part: .review, edits: edits, today: today, seen: try json(#"{"r":1}"#)))
        XCTAssertEqual((try JSONSerialization.jsonObject(with: withSeen) as? NSDictionary)?["seen"] as? NSDictionary, ["r": 1])
        XCTAssertNil((try JSONSerialization.jsonObject(with: chat) as? NSDictionary)?["seen"], "no seen, no key")
        // The engine's own Undo goes back exactly as it came, with no key added.
        let undo = #"{"kind":"medicationUndo","rows":[{"key":"statin","drug":null,"dose":2.5}]}"#
        let back = try JSONEncoder().encode(RecordEdit.engineEdit(try json(undo)))
        XCTAssertEqual(try JSONSerialization.jsonObject(with: back) as? NSDictionary, try JSONSerialization.jsonObject(with: Data(undo.utf8)) as? NSDictionary)
    }

    // MARK: AC3: what saves when

    func testAMedicationChangeSavesAtOnceAndUndoWritesTheEnginesUndo_US67_AC3() async throws {
        let (store, edits, engine) = try setUpEdits()
        let before = store.recordJSON
        await edits.take(try json(medication), asked: store.mark, today: today)
        XCTAssertNotEqual(store.recordJSON, before, "written on arrival, as on the web")
        XCTAssertEqual(try String(contentsOf: RecordStore.file(in: folder), encoding: .utf8), store.recordJSON)
        XCTAssertEqual(try sent(engine), [["kind": "chatEdits", "part": "medications", "today": today, "edits": try JSONSerialization.jsonObject(with: Data(medication.utf8))]])
        XCTAssertEqual(edits.saved?.lines, [.init(text: "Statin: atorvastatin 20 mg")])
        XCTAssertNil(edits.review)
        XCTAssertEqual(events, [.chatEditSaved, .chatEditProposed])

        let saved = store.recordJSON
        await edits.undo()
        XCTAssertEqual(try sent(engine).last, ["kind": "chatUndo", "medications": [1.5, NSNull(), true]], "the engine's Undo, as it came")
        XCTAssertNotEqual(store.recordJSON, saved)
        XCTAssertNil(edits.saved)
        XCTAssertEqual(events, [.chatEditSaved, .chatEditProposed], "an Undo is not a chat edit saved")
    }

    /// US-67 N3 (Brad 2026-11-02): a change that replaced an entry this app cannot read is
    /// written and shown, with no Undo: Undo could not put that entry back.
    func testAWrittenChangeWithNoUndoShowsItsLinesAndNoUndo_US67_N3() async throws {
        let (store, edits, engine) = try setUpEdits()
        let before = store.recordJSON
        let change = #"[{"kind":"medication","medicationKey":"statin","drug":"atorvastatin","dose":20,"unit":"mg","noUndo":true}]"#
        await edits.take(try json(change), asked: store.mark, today: today)
        XCTAssertNotEqual(store.recordJSON, before, "still written")
        XCTAssertEqual(try sent(engine).count, 1)
        let saved = try XCTUnwrap(edits.saved, "the banner shows")
        XCTAssertEqual(saved.lines, [.init(text: "Statin: atorvastatin 20 mg")])
        XCTAssertNil(saved.undo)
        XCTAssertNil(edits.problem)
        XCTAssertEqual(events, [.chatEditSaved, .chatEditProposed])

        // On screen: the lines and the fixed line, and no Undo button.
        let shown = banner(edits)
        XCTAssertTrue(shown.contains("Statin: atorvastatin 20 mg"))
        XCTAssertTrue(shown.contains(noUndo))
        XCTAssertFalse(shown.contains(undoHint), "no Undo button")

        // Undo, if reached anyway, writes nothing.
        let written = store.recordJSON
        await edits.undo()
        XCTAssertEqual(store.recordJSON, written)
        XCTAssertEqual(try sent(engine).count, 1, "no Undo sent")

        // An erase drops it, as any banner (AC5).
        edits.drop()
        XCTAssertNil(edits.saved)
    }

    /// A readable change keeps its Undo button, and no fixed line (the N3 control).
    func testAWrittenChangeWithItsUndoShowsTheUndoButton_US67_N3() async throws {
        let (store, edits, _) = try setUpEdits()
        await edits.take(try json(medication), asked: store.mark, today: today)
        let shown = banner(edits)
        XCTAssertTrue(shown.contains(undoHint), "the Undo button")
        XCTAssertFalse(shown.contains(noUndo))
    }

    private let undoHint = "Puts your medications back as they were"
    /// The fixed line as `dump` writes it: its apostrophes escaped.
    private let noUndo = ChatEdits.noUndo.replacingOccurrences(of: "'", with: "\\'")

    /// The banners' view tree as built, words and Undo's hint included. Undo's hint marks its button.
    private func banner(_ edits: ChatEdits) -> String {
        var tree = ""
        dump(ChatEditBanners(edits: edits).body, to: &tree)
        XCTAssertTrue(tree.contains("Medication updated from chat"), "the banner was built")
        return tree
    }

    func testValuesWaitForSave_US67_AC3() async throws {
        let (store, edits, engine) = try setUpEdits()
        let before = store.recordJSON
        await edits.take(try json(values), asked: store.mark, today: today)
        XCTAssertEqual(store.recordJSON, before, "nothing is written before Save")
        XCTAssertEqual(try sent(engine), [])
        XCTAssertEqual(edits.review?.lines, [.init(text: "Weight 80 kg", replaces: "82 kg"), .init(text: "Height 178 cm")])
        XCTAssertNil(edits.saved)
        XCTAssertEqual(events, [.chatEditProposed])

        await edits.save()
        XCTAssertEqual(try sent(engine), [["kind": "chatEdits", "part": "review", "today": today, "edits": try JSONSerialization.jsonObject(with: Data(values.utf8)),
                                           "seen": ["revision": "r1", "at": [2, 0.5]]]], "the preview's seen goes back as it came")
        XCTAssertNotEqual(store.recordJSON, before)
        XCTAssertNil(edits.review)
        XCTAssertEqual(events, [.chatEditProposed, .chatEditSaved])
    }

    func testNotNowWritesNothing_US67_AC3() async throws {
        let (store, edits, engine) = try setUpEdits()
        let before = store.recordJSON
        await edits.take(try json(values), asked: store.mark, today: today)
        edits.notNow()
        await edits.save() // nothing left to save
        XCTAssertNil(edits.review)
        XCTAssertEqual(store.recordJSON, before)
        XCTAssertEqual(try sent(engine), [])
        XCTAssertEqual(events, [.chatEditProposed])
    }

    func testARefusalShowsItsWordsAndHasNoSave_US67_AC3() async throws {
        let (store, edits, engine) = try setUpEdits()
        let before = store.recordJSON
        await edits.take(try json(#"[{"kind":"field","field":"weightKg","displayValue":900,"unitSystem":"si","refuse":true}]"#), asked: store.mark, today: today)
        XCTAssertEqual(edits.review?.refusal, "That weight is outside the range the app can save.")
        await edits.save()
        XCTAssertEqual(store.recordJSON, before)
        XCTAssertEqual(try sent(engine), [])
        XCTAssertNotNil(edits.review, "the refusal stays until closed")
    }

    func testANewRepliesBannerReplacesAnUnansweredOne_US67_AC3() async throws {
        let (store, edits, _) = try setUpEdits()
        await edits.take(try json(values), asked: store.mark, today: today)
        let first = try XCTUnwrap(edits.review)
        await edits.take(try json(values), asked: store.mark, today: today)
        XCTAssertNotEqual(edits.review?.id, first.id)
        XCTAssertEqual(events, [.chatEditProposed, .chatEditProposed], "once per reply that shows a banner")
    }

    // MARK: AC5: erase

    func testAnEraseDropsTheBannerAndTheUndoAndTheyWriteNothing_US67_AC5() async throws {
        let (store, edits, engine) = try setUpEdits()
        await edits.take(try json(medication), asked: store.mark, today: today)
        await edits.take(try json(values), asked: store.mark, today: today)
        let mark = store.mark
        guard case .erased = await store.erasePhone(historyJSON: nil, keepChat: { _, _ in true }) else { return XCTFail("not erased") }
        XCTAssertNotEqual(store.mark, mark, "ChatView drops the banners when the mark moves")
        let erased = store.recordJSON

        // Held past the erase (the view not yet told), neither Save nor Undo writes.
        await edits.save()
        XCTAssertEqual(edits.review?.refusal, "Your data was deleted since the chat suggested this, so it was not saved.")
        await edits.undo()
        XCTAssertEqual(store.recordJSON, erased)
        XCTAssertEqual(try sent(engine).count, 1, "only the medication change made before the erase")

        edits.drop()
        XCTAssertNil(edits.saved)
        XCTAssertNil(edits.review)
        XCTAssertNil(edits.problem)
    }

    func testAReplyToAQuestionAskedBeforeAnEraseAppliesNothing_US67_AC5() async throws {
        let (store, edits, engine) = try setUpEdits()
        let asked = store.mark
        guard case .erased = await store.erasePhone(historyJSON: nil, keepChat: { _, _ in true }) else { return XCTFail("not erased") }
        let erased = store.recordJSON
        await edits.take(try json(medication), asked: asked, today: today)
        await edits.take(try json(values), asked: asked, today: today)
        XCTAssertEqual(store.recordJSON, erased)
        XCTAssertEqual(try sent(engine), [])
        XCTAssertNil(edits.saved)
        XCTAssertNil(edits.review)
        XCTAssertEqual(events, [])
        XCTAssertEqual(edits.problem, "Not saved: your record changed since you asked.", "the reply's words are not left claiming a save (AC3)")
    }

    /// An erase from another device arrives as a record with a higher eraseEpoch: it is counted
    /// here as it lands, the mark moves, and a banner made before it writes nothing.
    func testAnEraseArrivingBySyncMovesTheMark_US67_AC5() async throws {
        let (store, edits, engine) = try setUpEdits()
        await edits.take(try json(values), asked: store.mark, today: today)
        let mark = store.mark
        let (record, deviceId) = (store.recordJSON, store.deviceId)
        let erased = try engine.blocking { try $0.eraseOnPhone(recordJSON: record, historyJSON: nil, now: .now, deviceId: deviceId).record }
        try RecordStore.write(erased, to: RecordStore.file(in: folder))
        await store.showPhone().value
        XCTAssertEqual(store.erasures, mark.erasures + 1, "an erase taken in is counted once (US-25 AC16j)")
        XCTAssertNotEqual(store.mark, mark)
        await edits.save()
        XCTAssertEqual(store.recordJSON, erased)
        XCTAssertEqual(try sent(engine), [])
    }

    // MARK: The engine's own door (no stand-in)

    /// The real `chatEditsJson` and edit kinds: a medication change lands and its Undo takes
    /// it back; a weight waits for Save, then lands.
    func testTheEnginesDoorSavesAndUndoes_US67_AC3_AC4() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        let edits = ChatEdits(store: store)
        await edits.take(try json(#"[{"kind":"medication","medicationKey":"statin","drugName":"atorvastatin","doseValue":20,"doseUnit":"mg"}]"#), asked: store.mark, today: today)
        XCTAssertNotNil(edits.saved, edits.problem ?? "no banner")
        XCTAssertTrue(store.recordJSON.contains("atorvastatin"))
        await edits.undo()
        XCTAssertNil(edits.problem)
        XCTAssertNil(edits.saved)

        await edits.take(try json(#"[{"kind":"field","field":"weightKg","displayValue":84,"unitSystem":"si","date":null}]"#), asked: store.mark, today: today)
        XCTAssertNil(edits.review?.refusal)
        XCTAssertFalse(edits.review?.lines.isEmpty ?? true)
        let (record, deviceId) = (store.recordJSON, store.deviceId)
        XCTAssertEqual(try engine.blocking { try $0.history(recordJSON: record, metric: "weight", now: .now, deviceId: deviceId) }.rows.count, 0, "nothing before Save")
        await edits.save()
        XCTAssertNil(edits.review)
        let saved = store.recordJSON
        XCTAssertEqual(try engine.blocking { try $0.history(recordJSON: saved, metric: "weight", now: .now, deviceId: deviceId) }.rows.count, 1)
    }

    /// US-67 AC3: a banner belongs to the conversation that made it. New chat and a
    /// conversation opened from History drop it (ChatView calls `drop` in both), and nothing is written.
    func testANewOrOpenedConversationDropsTheBanners_US67_AC3() async throws {
        let (store, edits, engine) = try setUpEdits()
        await edits.take(try json(medication), asked: store.mark, today: today)
        await edits.take(try json(values), asked: store.mark, today: today)
        let record = store.recordJSON
        edits.drop()
        XCTAssertNil(edits.saved)
        XCTAssertNil(edits.review)
        await edits.save()
        await edits.undo()
        XCTAssertEqual(store.recordJSON, record, "a dropped banner writes nothing")
        XCTAssertEqual(try sent(engine).count, 1, "only the medication change made on arrival")

        let source = try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "HealthRoadmap/Chat/ChatView.swift"), encoding: .utf8)
        for function in ["private func startNew()", "private func open(_ id: String)"] {
            let body = try XCTUnwrap(source.range(of: function)).upperBound
            let next = source.range(of: "\n    private func ", options: .regularExpression, range: body..<source.endIndex)?.lowerBound ?? source.endIndex
            XCTAssertTrue(source[body..<next].contains("edits.drop()"), "\(function) drops the banners")
        }
    }

    // MARK: Review fixes (R1, R3, R4)

    /// R1, US-67 AC3: a preview the engine cannot make says so; nothing is written.
    func testAPreviewTheEngineCannotMakeSaysNothingWasSaved_US67_AC3() async throws {
        let (store, edits, engine) = try setUpEdits()
        let before = store.recordJSON
        await edits.take(try json(#"[{"kind":"medication","boom":true}]"#), asked: store.mark, today: today)
        XCTAssertEqual(edits.problem, "These changes could not be shown, so nothing was saved.")
        XCTAssertNil(edits.saved)
        XCTAssertNil(edits.review)
        XCTAssertEqual(store.recordJSON, before)
        XCTAssertEqual(try sent(engine), [])
        XCTAssertEqual(events, [])
    }

    /// R4, US-67 AC5: connecting or disconnecting a cloud is not an erase; another cloud erase,
    /// a higher eraseEpoch or an erase on this phone is.
    func testOnlyAnEraseMovesTheMark_US67_AC5() {
        let phone = RecordStore.Mark(erase: nil, epoch: 0, erasures: 0)
        let cloud = RecordStore.Mark(erase: "e1", epoch: 0, erasures: 0)
        XCTAssertTrue(phone.holds(at: cloud), "a cloud connected")
        XCTAssertTrue(cloud.holds(at: phone), "a cloud disconnected")
        XCTAssertTrue(cloud.holds(at: cloud))
        XCTAssertFalse(cloud.holds(at: RecordStore.Mark(erase: "e2", epoch: 0, erasures: 0)), "the cloud was erased")
        XCTAssertFalse(phone.holds(at: RecordStore.Mark(erase: nil, epoch: 1, erasures: 0)), "an erase arrived by sync")
        XCTAssertFalse(phone.holds(at: RecordStore.Mark(erase: nil, epoch: 0, erasures: 1)), "an erase on this phone")
    }

    /// R4, US-67 AC5: the view follows the record: an erase drops the banners, a mark that
    /// only gained or lost a cloud keeps them.
    func testFollowingTheRecordDropsBannersOnlyOnAnErase_US67_AC5() async throws {
        let (store, edits, _) = try setUpEdits()
        await edits.take(try json(medication), asked: store.mark, today: today)
        await edits.take(try json(values), asked: store.mark, today: today)
        let mark = store.mark
        edits.follow(RecordStore.Mark(erase: "e1", epoch: mark.epoch, erasures: mark.erasures))
        XCTAssertNotNil(edits.saved, "a cloud connect keeps the Undo")
        XCTAssertNotNil(edits.review, "and the banner")
        guard case .erased = await store.erasePhone(historyJSON: nil, keepChat: { _, _ in true }) else { return XCTFail("not erased") }
        edits.follow(store.mark)
        XCTAssertNil(edits.saved)
        XCTAssertNil(edits.review)
    }

    /// R4, US-67 AC3: a medication change that was written always shows its Undo, even when
    /// the conversation moved on (New chat) while it was written.
    func testAWrittenMedicationChangeAlwaysGetsItsUndo_US67_AC3() async throws {
        let (store, edits, engine) = try setUpEdits()
        let both = #"[{"kind":"medication","medicationKey":"statin"},{"kind":"field","field":"weightKg","displayValue":80,"unitSystem":"si","date":null}]"#
        let taking = Task { await edits.take(try! json(both), asked: store.mark, today: today) }
        await Task.yield()
        edits.drop() // New chat while the turn runs
        await taking.value
        XCTAssertEqual(try sent(engine).count, 1, "the medication change was written")
        XCTAssertNotNil(edits.saved, "so its Undo shows")
        XCTAssertNil(edits.review, "the values banner belonged to the old conversation")
    }

    /// R3, US-67 AC5: a reply whose turn ran just before an erase writes, then the erase takes
    /// it: the screen says it was not saved, and no Undo is offered.
    func testAnEraseRightAfterTheWriteLeavesNoUndo_US67_AC5() async throws {
        let (store, edits, _) = try setUpEdits()
        let taking = Task { await edits.take(try! json(medication), asked: store.mark, today: today) }
        let erasing = Task { await store.erasePhone(historyJSON: nil, keepChat: { _, _ in true }) }
        await taking.value
        _ = await erasing.value
        edits.follow(store.mark)
        XCTAssertNil(edits.saved, "an Undo for an erased change is never offered")
    }

    // MARK: Re-check fixes (N5, Codex R2)

    private let unreadable = #"[{"kind":"medication","boom":true}]"#

    /// N5, US-67 AC3: a later reply that cannot be shown keeps an earlier reply's Undo.
    func testAProblemLineKeepsAnEarlierUndo_US67_AC3() async throws {
        let (store, edits, _) = try setUpEdits()
        await edits.take(try json(medication), asked: store.mark, today: today)
        let undo = try XCTUnwrap(edits.saved)
        await edits.take(try json(unreadable), asked: store.mark, today: today)
        XCTAssertEqual(edits.problem, "These changes could not be shown, so nothing was saved.")
        XCTAssertEqual(edits.saved, undo, "the earlier Undo stays")
    }

    /// N5, US-67 AC3: an answer that lands after New chat stays out of the new conversation.
    func testAProblemFromTheOldConversationNeverLandsInTheNewOne_US67_AC3() async throws {
        let (store, edits, _) = try setUpEdits()
        let taking = Task { await edits.take(try! json(unreadable), asked: store.mark, today: today) }
        await Task.yield()
        edits.drop() // New chat
        await taking.value
        XCTAssertNil(edits.problem)
    }

    /// N5, US-67 AC3: a later reply's banner replaces the problem line.
    func testALaterBannerReplacesTheProblemLine_US67_AC3() async throws {
        let (store, edits, _) = try setUpEdits()
        await edits.take(try json(unreadable), asked: store.mark, today: today)
        XCTAssertNotNil(edits.problem)
        await edits.take(try json(values), asked: store.mark, today: today)
        XCTAssertNil(edits.problem)
        XCTAssertNotNil(edits.review)
    }

    /// N5, US-67 AC5: an erase clears a problem line made before it; a cloud connect does not.
    func testAnEraseClearsAStaleProblemLine_US67_AC5() async throws {
        let (store, edits, _) = try setUpEdits()
        await edits.take(try json(unreadable), asked: store.mark, today: today)
        let mark = store.mark
        edits.follow(RecordStore.Mark(erase: "e1", epoch: mark.epoch, erasures: mark.erasures))
        XCTAssertNotNil(edits.problem, "a cloud connect keeps it")
        guard case .erased = await store.erasePhone(historyJSON: nil, keepChat: { _, _ in true }) else { return XCTFail("not erased") }
        edits.follow(store.mark)
        XCTAssertNil(edits.problem)
    }

    /// Codex R2, US-67 AC3: a medication change the engine refuses is never applied, and its
    /// words show as the problem line; the values part is unaffected.
    func testARefusedMedicationChangeIsNeverApplied_US67_AC3() async throws {
        let (store, edits, engine) = try setUpEdits()
        let before = store.recordJSON
        let refused = #"[{"kind":"medication","refuseMeds":true},{"kind":"field","field":"weightKg","displayValue":80,"unitSystem":"si","date":null}]"#
        await edits.take(try json(refused), asked: store.mark, today: today)
        XCTAssertEqual(store.recordJSON, before)
        XCTAssertEqual(try sent(engine), [], "the medications part was never sent to be written")
        XCTAssertNil(edits.saved)
        XCTAssertEqual(edits.problem, "That medicine is not on the list, so nothing was saved.")
        XCTAssertNotNil(edits.review, "the values still wait for Save")
    }

    /// Codex R2, US-67 AC3, on the engine's own door: a medication edit it cannot read is
    /// refused in the preview, never written, and its words show.
    func testTheEngineRefusesAnUnreadableMedicationChange_US67_AC3() async throws {
        let store = try RecordStore(folder: folder, engine: HealthEngine(), deviceId: "test")
        let edits = ChatEdits(store: store)
        let before = store.recordJSON
        await edits.take(try json(#"[{"kind":"medication","medicationKey":"not-a-medicine","drugName":"x","doseValue":null,"doseUnit":null}]"#), asked: store.mark, today: today)
        XCTAssertEqual(store.recordJSON, before)
        XCTAssertNil(edits.saved)
        XCTAssertFalse(edits.problem?.isEmpty ?? true, "the engine's words show")
    }
}
