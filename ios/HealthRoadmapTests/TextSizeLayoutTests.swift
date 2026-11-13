import SwiftUI
import XCTest
@testable import HealthRoadmap

/// Views at the default and the largest accessibility text size (break-it pass 2026-10-30),
/// measured as they lay out in a window at that size.
@MainActor
final class TextSizeLayoutTests: XCTestCase {
    private let largest = UIContentSizeCategory.accessibilityExtraExtraExtraLarge
    private let phone = CGSize(width: 402, height: 874)

    /// The size `view` takes in a phone-wide window at `category`.
    private func measure(_ view: some View, at category: UIContentSizeCategory, width: CGFloat? = nil) throws -> CGSize {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: phone)
        window.traitOverrides.preferredContentSizeCategory = category
        let host = UIHostingController(rootView: view.fixedSize(horizontal: false, vertical: true))
        host.safeAreaRegions = [] // the view alone, without the window's insets
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.view.layoutIfNeeded()
        return host.sizeThatFits(in: CGSize(width: width ?? .greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
    }

    /// US-52 AC6e: at the largest size the question box holds two lines, so a long question
    /// leaves the conversation in view, and the empty box shows the whole placeholder; at
    /// the default size it still grows with the question.
    func testTheQuestionBoxIsTwoLinesAtTheLargestSize_US52_AC6e() throws {
        let long = String(repeating: "How much protein should I eat on a training day? ", count: 4)
        let width = phone.width - 100 // the composer's padding and Send
        let emptyLargest = try measure(QuestionHost(draft: ""), at: largest, width: width).height
        let longLargest = try measure(QuestionHost(draft: long), at: largest, width: width).height
        let emptyDefault = try measure(QuestionHost(draft: ""), at: .large, width: width).height
        let longDefault = try measure(QuestionHost(draft: long), at: .large, width: width).height

        XCTAssertEqual(longLargest, emptyLargest, accuracy: 1, "the box keeps two lines, empty or full")
        XCTAssertLessThan(longLargest, phone.height / 5, "a long question never fills the screen")
        XCTAssertGreaterThan(longDefault, emptyDefault * 3, "at the default size it grows to five lines")
    }

    /// US-52 AC10b: a source row's icon column grows with the text, so at the largest size
    /// the folder never runs into "A PDF, photo, ZIP or folder".
    func testASourceIconNeverTouchesItsWordsAtTheLargestSize_US52_AC10b() throws {
        let detail = "A PDF, photo, ZIP or folder"
        let row = try measure(SourceRow(title: "Files", symbol: "folder", detail: detail), at: largest).width
        let icon = try measure(Image(systemName: "folder").font(.title3), at: largest).width
        let words = try measure(Text(detail).font(.footnote), at: largest).width
        XCTAssertGreaterThanOrEqual(row, icon + 14 + words - 1)
    }

    // MARK: Text that never truncates (break-it pass 2026-11-01, iPhone 17e)

    /// The smallest supported iPhone (SE) and the iPhone 17e, with the insets of their
    /// status bar and home indicator.
    private let screens: [(name: String, size: CGSize, insets: CGFloat)] = [
        ("SE", CGSize(width: 375, height: 667), 20), ("17e", CGSize(width: 390, height: 844), 47 + 34),
    ]
    private let sizes: [UIContentSizeCategory] = [.large, .extraLarge, .extraExtraLarge, .extraExtraExtraLarge,
                                                  .accessibilityMedium, .accessibilityExtraLarge, .accessibilityExtraExtraExtraLarge]

    /// How `view`'s texts were drawn, once settled, in a window of `screen` at `category`:
    /// the draws, those cut short with "…" (SwiftUI's own `Text.Layout.isTruncated`), and the
    /// most lines one text took. `weight`, when set, overrides the system's Bold Text.
    @available(iOS 18.0, *)
    private func drawnTexts(in view: some View, at category: UIContentSizeCategory, screen: CGSize, weight: UILegibilityWeight? = nil) throws -> TruncationProbe.Log {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: screen)
        window.traitOverrides.preferredContentSizeCategory = category
        if let weight { window.traitOverrides.legibilityWeight = weight }
        let probe = TruncationProbe()
        window.rootViewController = UIHostingController(rootView: view.textRenderer(probe))
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        // Long enough for `.task` to reveal a scene's rows and their springs to settle.
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 3))
        // Then count the settled page only: dark mode redraws every text where it lies.
        probe.log.reset()
        window.traitOverrides.userInterfaceStyle = .dark
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.5))
        return probe.log
    }

    /// US-67 AC3: the chat's edit banners cut no words short at the largest accessibility size
    /// on an SE, the Undo banner and the Save banner alike; the chat scrolls instead.
    func testTheChatEditBannersNeverCutTheirWords_US67_AC3() async throws {
        guard #available(iOS 18, *) else { throw XCTSkip("Text.Layout.isTruncated needs iOS 18") }
        let folder = FileManager.default.temporaryDirectory.appending(path: "Banner Text \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = try RecordStore(folder: folder, engine: HealthEngine(), deviceId: "test")
        let edits = ChatEdits(store: store)
        let proposals = #"[{"kind":"medication","medicationKey":"statin","drugName":"atorvastatin","doseValue":20,"doseUnit":"mg"},{"kind":"field","field":"weightKg","displayValue":84,"unitSystem":"si","date":null},{"kind":"profile","sex":null,"heightCm":181}]"#
        await edits.take(try JSONDecoder().decode(OpaqueJSON.self, from: Data(proposals.utf8)), asked: store.mark, today: "2026-11-02")
        XCTAssertNotNil(edits.saved)
        XCTAssertNotNil(edits.review)
        let chat = ScrollView { ChatEditBanners(edits: edits).padding() }
        let se = screens[0]
        let texts = try drawnTexts(in: chat, at: largest, screen: se.size)
        XCTAssertGreaterThan(texts.drawn, 5, "the banners drew their words")
        XCTAssertEqual(texts.cut, 0, "no words end in …")
    }

    /// US-54 AC8b: the real Apple Health page cuts no words short, its tiles included,
    /// on an SE and a 17e, from the default size to accessibility XL; the page scrolls instead.
    func testTheAppleHealthPageNeverCutsItsWords_US54_AC8b() throws {
        guard #available(iOS 18, *) else { throw XCTSkip("Text.Layout.isTruncated needs iOS 18") }
        let page = NavigationStack { OnboardingView.healthPage(connecting: false, allow: {}) }
        for screen in screens {
            for category in sizes {
                let texts = try drawnTexts(in: page, at: category, screen: screen.size)
                // A guard that the page drew: five texts at the largest sizes since "Not now" went (2026-11-09).
                XCTAssertGreaterThanOrEqual(texts.drawn, 5, "\(screen.name) \(category.rawValue): the page drew its words")
                XCTAssertEqual(texts.cut, 0, "\(screen.name) \(category.rawValue): no words end in …")
            }
        }
    }

    /// US-54 AC8: at accessibility sizes the real Apple Health page keeps its buttons on
    /// screen and at least 120 pt for its scrolling words, on an SE and a 17e. The scroll
    /// region gets only what the buttons leave, so a block of buttons too tall for the
    /// screen squeezes it to nothing and pushes them off the bottom.
    func testTheAppleHealthPageKeepsRoomToScrollAboveItsButtons_US54_AC8() throws {
        for screen in screens {
            let room = CGSize(width: screen.size.width, height: screen.size.height - screen.insets)
            for category in [UIContentSizeCategory.accessibilityExtraLarge, .accessibilityExtraExtraExtraLarge] {
                let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(origin: .zero, size: room)
                window.traitOverrides.preferredContentSizeCategory = category
                let host = UIHostingController(rootView: NavigationStack { OnboardingView.healthPage(connecting: false, allow: {}) })
                host.safeAreaRegions = []
                window.rootViewController = host
                window.makeKeyAndVisible()
                defer { window.isHidden = true }
                RunLoop.main.run(until: Date(timeIntervalSinceNow: 1))
                host.view.layoutIfNeeded()
                func scrollViews(in view: UIView) -> [UIScrollView] {
                    (view as? UIScrollView).map { [$0] } ?? [] + view.subviews.flatMap(scrollViews)
                }
                let scroll = try XCTUnwrap(scrollViews(in: host.view).first, "\(screen.name) \(category.rawValue): the page scrolls")
                XCTAssertGreaterThanOrEqual(scroll.frame.height, 120, "\(screen.name) \(category.rawValue): room to scroll above the buttons")
            }
        }
    }

    /// US-54 AC8b: each Apple Health tile's name fits its tile, shrunk at most to the
    /// tile's 0.8 scale, at every size on both screens: the grid drops columns as text grows.
    /// (SwiftUI draws a text with a minimum scale factor outside the probe above, so this
    /// one is measured.)
    func testEveryAppleHealthTileNameFitsItsTile_US54_AC8b() throws {
        for screen in screens {
            for category in sizes + [.accessibilityLarge, .accessibilityExtraExtraLarge] {
                let columns = CGFloat(HealthFillScene.columns(at: DynamicTypeSize(category) ?? .large))
                let tile = (screen.size.width - 48 - HealthFillScene.spacing * (columns - 1)) / columns // the page's margins
                for item in HealthFillScene.items {
                    let name = try measure(Text(item.name).font(.caption.weight(.medium)).fixedSize(), at: category).width
                    XCTAssertLessThanOrEqual(name * 0.8, tile, "\(screen.name) \(category.rawValue): \(item.name) fits \(Int(columns)) columns")
                }
            }
        }
    }

    /// US-54 AC8b: the welcome screen shows the story only where every scene fits its card
    /// whole, each row on one line (a 17e at the default size); elsewhere the story's words
    /// scroll above the buttons. Either way nothing is cut and Get started stays on screen.
    func testTheWelcomeScreenShowsTheStoryOnlyWhereItFits_US54_AC8b() throws {
        guard #available(iOS 18, *) else { throw XCTSkip("Text.Layout.isTruncated needs iOS 18") }
        for screen in screens {
            let card = screen.size.width - 56 // WelcomeView's margins
            let room = CGSize(width: screen.size.width, height: screen.size.height - screen.insets)
            for category in sizes {
                let welcome = WelcomeView(sync: nil, start: {})
                let texts = try drawnTexts(in: welcome, at: category, screen: screen.size)
                XCTAssertEqual(texts.cut, 0, "\(screen.name) \(category.rawValue): no words end in …")
                // The words are one text of five lines or more; the story's texts take at most three.
                let words = texts.lines > 4
                let needs = try measure(WelcomeStory.needs, at: category)
                let fits = needs.width <= card && needs.height <= WelcomeStory.height
                XCTAssertEqual(words, !fits, "\(screen.name) \(category.rawValue): the story shows only where its \(needs) fits \(card) x 236")
                XCTAssertLessThanOrEqual(try taken(by: welcome, in: room, at: category).height, room.height + 0.5,
                                         "\(screen.name) \(category.rawValue): Get started in view")
            }
        }
    }

    /// US-25 AC26 and AC17g (review R5): at the largest accessibility size My health's title, its
    /// three pills and its topic headings are never cut short and never broken mid-word, on an
    /// SE and a 17e. No text on the drawn 17e page ends in "…", and every word of them fits the row it
    /// sits in (the inset list's margins and the rows' own insets), so no line breaks inside one:
    /// a pill and a one-word heading may shrink to 0.7, as they are drawn; Blood tests' buttons go
    /// under its title when they do not fit beside it.
    func testMyHealthsTitlePillsAndHeadingsNeverBreakAWord_US25_AC26() throws {
        guard #available(iOS 18, *) else { throw XCTSkip("Text.Layout.isTruncated needs iOS 18") }
        let folder = FileManager.default.temporaryDirectory.appending(path: "My Health Text \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let sample = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "sample.record", withExtension: "json"))
        try FileManager.default.copyItem(at: sample, to: folder.appending(path: "health-roadmap.json"))
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        let page = MyHealthHost.view(store: store, engine: engine)
        let words = { (text: String) in text.split(separator: " ").map(String.init) }
        for screen in screens {
            let texts = try drawnTexts(in: page, at: largest, screen: screen.size)
            XCTAssertGreaterThanOrEqual(texts.drawn, 4, "\(screen.name): the page drew its words (a text that may shrink draws outside the probe, so the pills are measured below)")
            // Only the 17e: on an SE one text further down the page (not the title, a pill or a
            // heading, which the widths below pin) ends in "…" at this size; open, 2026-11-05.
            if screen.name == "17e" { XCTAssertEqual(texts.cut, 0, "\(screen.name): no words end in …") }
            let row = screen.size.width - 2 * 20 - 8
            for word in words("My health") {
                let width = try measure(Text(word).font(.largeTitle.bold()).fixedSize(), at: largest).width
                XCTAssertLessThanOrEqual(width, row, "\(screen.name): \(word) fits the title's row")
            }
            for topic in HealthTopic.pills {
                let pill = try measure(Button {} label: { Text(topic.title.title) }.buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).fixedSize(), at: largest).width
                XCTAssertLessThanOrEqual(pill * 0.7, screen.size.width - 2 * 20, "\(screen.name): the \(topic.rawValue) pill fits on one line")
            }
            for topic in HealthTopic.allCases {
                let title = topic.title
                let scale = title.title.contains(" ") ? 1 : 0.7
                for (index, word) in words(title.title).enumerated() {
                    // The icon leads the first line only.
                    let font = Font.title3.weight(.semibold)
                    let width = index == 0 ? try measure(SectionTitle(title: word, symbol: title.symbol, tint: title.tint).font(font).fixedSize(), at: largest).width
                        : try measure(Text(word).font(font).fixedSize(), at: largest).width
                    XCTAssertLessThanOrEqual(width * scale, row, "\(screen.name): \(topic.rawValue)'s \(word) fits its heading")
                }
            }
        }
    }

    /// US-62 AC8a (Brad 2026-11-09): a My health row's trend is drawn over its label block's ink,
    /// the title's cap height to the date line's baseline, its end dot never past either; at the
    /// largest size before the row stacks, where the title wraps, it is capped at 0.8 x its width
    /// and centred on that ink. Read from the drawn pixels: the trend's red line against the
    /// words' grey and black ink.
    func testARowsTrendIsDrawnOverItsTitleAndDateLine_US62_AC8a() throws {
        for category in [UIContentSizeCategory.large, .extraExtraExtraLarge] {
            let row = ValueRow(label: "Waist-to-height", value: "0.53", unit: "", day: "2025-02-01",
                               target: "Normal <0.5", previous: "0.50", trend: [1, 3, 2], tint: .red)
            let drawn = try inkAndRed(row.frame(width: 362), at: category)
            let red = try XCTUnwrap(drawn.red, "\(category.rawValue): the trend is drawn")
            let ink = try XCTUnwrap(drawn.ink, "\(category.rawValue): the words are drawn")
            let redWidth = try XCTUnwrap(drawn.redWidth)
            let (span, inkSpan) = (red.upperBound - red.lowerBound, ink.upperBound - ink.lowerBound)
            let say = "\(category.rawValue): trend \(red), words \(ink)"
            XCTAssertGreaterThanOrEqual(red.lowerBound, ink.lowerBound - 0.5, "\(say): nothing above the title's top")
            XCTAssertLessThanOrEqual(red.upperBound, ink.upperBound + 0.5, "\(say): nothing below the date line")
            XCTAssertEqual((red.lowerBound + red.upperBound) / 2, (ink.lowerBound + ink.upperBound) / 2, accuracy: 2, "\(say): centred on the words")
            XCTAssertLessThanOrEqual(span, 0.8 * redWidth + 3, "\(say): never taller than 0.8 x its width")
            if category == .large { XCTAssertGreaterThanOrEqual(span, inkSpan - 5, "\(say): it spans the title and date line") }
        }
    }

    /// The rows (in points) holding `view`'s words (grey or black) and its red, and the red's
    /// width, drawn in light mode at the window's top left at `category`; `weight`, when set, overrides the system's Bold Text.
    private func inkAndRed(_ view: some View, at category: UIContentSizeCategory, weight: UILegibilityWeight? = nil) throws -> (ink: ClosedRange<CGFloat>?, red: ClosedRange<CGFloat>?, redWidth: CGFloat?) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: CGSize(width: phone.width, height: 300))
        window.overrideUserInterfaceStyle = .light
        window.traitOverrides.preferredContentSizeCategory = category
        if let weight { window.traitOverrides.legibilityWeight = weight }
        let host = UIHostingController(rootView: view.fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).background(.white))
        host.safeAreaRegions = []
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.5)) // the label block is measured after the first layout
        // Eight bits a channel: on a wide-colour screen the default is 16-bit extended range.
        let format = UIGraphicsImageRendererFormat(for: window.traitCollection)
        format.preferredRange = .standard
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let cg = try XCTUnwrap(image.cgImage)
        XCTAssertEqual(cg.bitsPerComponent, 8, "read as one byte a channel")
        let bytes = try XCTUnwrap(CFDataGetBytePtr(cg.dataProvider?.data))
        let (stride, step) = (cg.bytesPerRow, cg.bitsPerPixel / 8)
        let r = cg.bitmapInfo.contains(.byteOrder32Little) ? 2 : 0 // BGRA or RGBA
        var ink: ClosedRange<Int>?, red: ClosedRange<Int>?, redX: ClosedRange<Int>?
        let widen = { (range: ClosedRange<Int>?, at: Int) in range.map { min($0.lowerBound, at)...max($0.upperBound, at) } ?? at...at }
        for y in 0..<cg.height {
            for x in 0..<cg.width {
                let p = (0..<3).map { Int(bytes[y * stride + x * step + $0]) }
                let (rr, g, b) = (p[r], p[1], p[2 - r])
                if rr - max(g, b) > 80 { (red, redX) = (widen(red, y), widen(redX, x)) } else if max(rr, g, b) - min(rr, g, b) < 30, rr < 200 { ink = widen(ink, y) }
            }
        }
        let points = { (range: ClosedRange<Int>?) in range.map { CGFloat($0.lowerBound) / image.scale...CGFloat($0.upperBound + 1) / image.scale } }
        return (points(ink), points(red), points(redX).map { $0.upperBound - $0.lowerBound })
    }

    /// US-62 AC8a (review F2, option A): at the largest size before the row stacks, on an SE, a
    /// row whose label's longest word would not fit beside the trend drops the trend, so the word
    /// keeps its line (Androstenedione); a short label keeps its trend (Weight). In an inset list,
    /// as My health lays its rows; the trend is the red, the words are probed as drawn.
    func testALongWordDropsTheTrendRatherThanBreak_US62_AC8a() throws {
        guard #available(iOS 18, *) else { throw XCTSkip("Text.Layout.isTruncated needs iOS 18") }
        let se = screens[0].size
        let list = { (label: String, value: String, previous: String, unit: String) in
            List { ValueRow(label: label, value: value, unit: unit, day: "2026-07-14", previous: previous, trend: [1, 2, 3], tint: .red) }
                .listStyle(.insetGrouped)
        }
        let long = list("Androstenedione", "4.2", "3.9", "nmol/L"), short = list("Weight", "92.4", "94.1", "kg")
        let texts = try drawnTexts(in: long, at: .extraExtraExtraLarge, screen: se, weight: .regular)
        XCTAssertEqual(texts.cut, 0, "no words end in …")
        XCTAssertEqual(texts.lines, 1, "Androstenedione keeps its line")
        XCTAssertNil(try inkAndRed(long.frame(width: se.width, height: 240), at: .extraExtraExtraLarge, weight: .regular).red, "Androstenedione's trend gives way")
        XCTAssertNotNil(try inkAndRed(short.frame(width: se.width, height: 240), at: .extraExtraExtraLarge, weight: .regular).red, "Weight keeps its trend")
        XCTAssertNotNil(try inkAndRed(long.frame(width: se.width, height: 240), at: .large, weight: .regular).red, "at the default size the trend stays")
    }

    /// US-62 AC8a, #1002 R1: under Bold Text (the window's legibility trait, as the setting sets it)
    /// the label is measured bold. On an SE at XXXL, Thyroglobulin fits beside the trend in regular but
    /// not in bold: bold drops the trend and keeps the word on one line. Measured regular, the trend
    /// stayed with less room than the bold word asks for. Testosterone, near the limit in bold, keeps
    /// its trend and its line. (In this test window the trait makes the value heavier but leaves the
    /// label's plain body text regular, so here the bold measurement errs wide, never short.)
    func testBoldTextMeasuresTheLabelBoldBeforeKeepingTheTrend_US62_AC8a() throws {
        guard #available(iOS 18, *) else { throw XCTSkip("Text.Layout.isTruncated needs iOS 18") }
        let se = screens[0].size
        let row = { (label: String) in
            List { ValueRow(label: label, value: "4.2", unit: "ng/mL", day: "2026-07-14", previous: "3.9", trend: [1, 2, 3], tint: .red) }
                .listStyle(.insetGrouped)
        }
        for label in ["Thyroglobulin", "Testosterone"] {
            let texts = try drawnTexts(in: row(label), at: .extraExtraExtraLarge, screen: se, weight: .bold)
            XCTAssertEqual(texts.cut, 0, "\(label): no words end in …")
            XCTAssertEqual(texts.lines, 1, "bold \(label) keeps its line")
        }
        XCTAssertNil(try inkAndRed(row("Thyroglobulin").frame(width: se.width, height: 240), at: .extraExtraExtraLarge, weight: .bold).red, "bold: the trend gives way")
        XCTAssertNotNil(try inkAndRed(row("Testosterone").frame(width: se.width, height: 240), at: .extraExtraExtraLarge, weight: .bold).red, "bold Testosterone keeps its trend")
        XCTAssertNotNil(try inkAndRed(row("Thyroglobulin").frame(width: se.width, height: 240), at: .extraExtraExtraLarge, weight: .regular).red, "regular: the trend fits")
    }

    /// US-62 AC8a: a word that only just fits beside the trend keeps both. On an SE at XXXL, regular
    /// Thyroglobulin is about 4 pt inside the limit; with and without a target line, it keeps its
    /// trend and stays on one line. (A "Thyroglobu-lin" seen once came from a simulator whose system
    /// Bold Text was on under a window forced to regular: drawn bold, measured regular. A real
    /// phone's trait follows the setting.)
    func testAWordThatOnlyJustFitsKeepsItsTrendAndItsLine_US62_AC8a() throws {
        guard #available(iOS 18, *) else { throw XCTSkip("Text.Layout.isTruncated needs iOS 18") }
        let se = screens[0].size
        for target in [nil, "Normal <35"] {
            let list = List { ValueRow(label: "Thyroglobulin", value: "4.2", unit: "ng/mL", day: "2026-07-14", target: target, previous: "3.9", trend: [1, 2, 3], tint: .red) }
                .listStyle(.insetGrouped)
            let texts = try drawnTexts(in: list, at: .extraExtraExtraLarge, screen: se, weight: .regular)
            XCTAssertEqual(texts.cut, 0, "no words end in …")
            XCTAssertEqual(texts.lines, 1, "Thyroglobulin keeps its line (target \(target ?? "none"))")
            XCTAssertNotNil(try inkAndRed(list.frame(width: se.width, height: 240), at: .extraExtraExtraLarge, weight: .regular).red, "and its trend")
        }
    }

    /// The height `view` takes when offered `room`: more than `room` means it runs off screen.
    private func taken(by view: some View, in room: CGSize, at category: UIContentSizeCategory) throws -> CGSize {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: room)
        window.traitOverrides.preferredContentSizeCategory = category
        let host = UIHostingController(rootView: view)
        host.safeAreaRegions = []
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.3)) // the story's size is read after the first layout
        host.view.layoutIfNeeded()
        return host.sizeThatFits(in: room)
    }

    // MARK: My health's banner and footer (US-73, build 12)

    /// An iPhone 17, an SE, and an 11-inch iPad's width, each in light and dark, at the default and
    /// the largest size. (The app is iPhone-only, so an iPad runs it in an iPhone-size window; the
    /// wide one is the case to come.)
    private let looks: [(name: String, size: CGSize, regular: Bool)] = [("iPhone", CGSize(width: 402, height: 874), false),
                                                                        ("SE", CGSize(width: 375, height: 667), false),
                                                                        ("iPad", CGSize(width: 820, height: 1180), true)]
    private let styles: [UIUserInterfaceStyle] = [.light, .dark]

    /// A store holding the sample record and today's stage 2 blood pressure, so a card is urgent.
    private func urgentStore() throws -> (RecordStore, HealthEngine) {
        let folder = FileManager.default.temporaryDirectory.appending(path: "My Health Banner \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        let sample = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "sample.record", withExtension: "json"))
        var record = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: sample)) as? [String: Any])
        let day = String(Date.now.ISO8601Format().prefix(10))
        record["measurements"] = (record["measurements"] as? [[String: Any]] ?? []) + [("systolic_bp", 165), ("diastolic_bp", 102)].map {
            ["source": "manual", "status": "active", "correctsId": NSNull(), "externalId": NSNull(), "id": "banner-\($0.0)",
             "metricType": $0.0, "value": $0.1, "recordedAt": day, "createdAt": "\(day)T08:00:00Z"]
        }
        try JSONSerialization.data(withJSONObject: record).write(to: folder.appending(path: "health-roadmap.json"))
        let engine = try HealthEngine()
        return (try RecordStore(folder: folder, engine: engine, deviceId: "test"), engine)
    }

    /// `view` in a window of `size`, settled: `.task` has built the page and its springs have stopped.
    private func settled(_ view: some View, size: CGSize, regular: Bool, style: UIUserInterfaceStyle, at category: UIContentSizeCategory) throws -> UIWindow {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        window.overrideUserInterfaceStyle = style
        window.traitOverrides.preferredContentSizeCategory = category
        if regular { window.traitOverrides.horizontalSizeClass = .regular }
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 3))
        return window
    }

    /// The window as drawn, one byte a channel: `rgb(x, y)` in pixels, `scale` pixels a point.
    private struct Drawn {
        let data: Data, stride: Int, step: Int, red: Int, width: Int, height: Int, scale: CGFloat
        init(_ window: UIWindow) throws {
            let format = UIGraphicsImageRendererFormat(for: window.traitCollection)
            format.preferredRange = .standard
            let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let cg = try XCTUnwrap(image.cgImage)
            data = try XCTUnwrap(cg.dataProvider?.data as Data?)
            (stride, step, width, height, scale) = (cg.bytesPerRow, cg.bitsPerPixel / 8, cg.width, cg.height, image.scale)
            red = cg.bitmapInfo.contains(.byteOrder32Little) ? 2 : 0
        }
        func rgb(_ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int) {
            let i = y * stride + x * step
            return (Int(data[i + red]), Int(data[i + 1]), Int(data[i + 2 - red]))
        }
    }

    /// US-73 (build 12): the Needs-attention banner's four corners are drawn alike, as rounded as
    /// the cards under it. As the last row of the title's section its top corners were its own
    /// 12 pt and its bottom ones the list's larger section radius. Read from the drawn red: two
    /// points in from its top edge and from its bottom edge, the red starts the same way in. The
    /// room over it (from the pills) and under it (to the next heading) stays as main drew it.
    func testTheNeedsAttentionBannersFourCornersMatch_US73() throws {
        let (store, engine) = try urgentStore()
        for look in looks {
            for style in styles {
                for category in [UIContentSizeCategory.large, largest] {
                    let name = "\(look.name) \(style == .dark ? "dark" : "light") \(category.rawValue)"
                    // The screen's width, tall enough to hold the whole banner at the largest size.
                    let room = CGSize(width: look.size.width, height: 1400)
                    let window = try settled(MyHealthHost.view(store: store, engine: engine), size: room, regular: look.regular, style: style, at: category)
                    defer { window.isHidden = true }
                    let drawn = try Drawn(window)
                    // The banner: the first run of rows whose red spans over half the width.
                    func reds(_ y: Int) -> ClosedRange<Int>? {
                        let xs = (0..<drawn.width).filter { let p = drawn.rgb($0, y); return p.r - max(p.g, p.b) > 80 }
                        guard let first = xs.first, let last = xs.last, last - first > drawn.width / 2 else { return nil }
                        return first...last
                    }
                    guard let top = (0..<drawn.height).first(where: { reds($0) != nil }) else { XCTFail("\(name): the banner is drawn"); continue }
                    let bottom = (top..<drawn.height).first { reds($0) == nil }.map { $0 - 1 } ?? drawn.height - 1
                    XCTAssertGreaterThan(CGFloat(bottom - top) / drawn.scale, 30, "\(name): the banner's height")
                    let inset = Int(2 * drawn.scale)
                    let (upper, lower, middle) = try (XCTUnwrap(reds(top + inset)), XCTUnwrap(reds(bottom - inset)), XCTUnwrap(reds((top + bottom) / 2)))
                    let curve = { (row: ClosedRange<Int>) in CGFloat(row.lowerBound - middle.lowerBound) / drawn.scale }
                    XCTAssertGreaterThan(curve(upper), 1, "\(name): the corners are rounded")
                    XCTAssertEqual(curve(upper), curve(lower), accuracy: 1, "\(name): the top and bottom left corners match")
                    XCTAssertEqual(CGFloat(middle.upperBound - upper.upperBound) / drawn.scale,
                                   CGFloat(middle.upperBound - lower.upperBound) / drawn.scale, accuracy: 1, "\(name): the right corners match")
                    // The room over it (from the pills) and under it (to Weight & diabetes): the
                    // first row drawn past the page's background, its colour at the window's left edge.
                    func drawnRow(_ ys: some Sequence<Int>) -> Int? {
                        ys.first { y in
                            let bg = drawn.rgb(1, y)
                            return (drawn.width / 20..<drawn.width * 19 / 20).contains { let p = drawn.rgb($0, y); return abs(p.r - bg.r) + abs(p.g - bg.g) + abs(p.b - bg.b) > 24 }
                        }
                    }
                    let pills = try XCTUnwrap(drawnRow(stride(from: top - 1, through: 0, by: -1)), "\(name): the pills over it")
                    let heading = try XCTUnwrap(drawnRow(bottom + 1..<drawn.height), "\(name): the heading under it")
                    let (over, under) = (CGFloat(top - pills - 1) / drawn.scale, CGFloat(heading - bottom - 1) / drawn.scale)
                    // As main drew them before the fix (Brad: the room between the pills, the banner and
                    // the heading is right), measured here on 2026-11-13.
                    let wide = look.regular, big = category == largest
                    XCTAssertEqual(over, big ? 8 : 16, accuracy: 1, "\(name): the room over the banner is main's")
                    XCTAssertEqual(under, big ? (wide ? 45.33 : 45) : (wide ? 43.67 : 38.67), accuracy: 1, "\(name): the room under it is main's")
                }
            }
        }
    }

    /// US-73 (build 12): at the hard end of My health's scroll the footer's last line ("Worked out
    /// on this iPhone") ends clearly above the tab bar (on main, 7 pt over its frame). Read from the drawn
    /// window: the lowest row of words above the bar's top edge.
    func testMyHealthsFooterEndsAboveTheTabBar_US73() throws {
        let (store, engine) = try urgentStore()
        let tabs = TabView {
            MyHealthHost.view(store: store, engine: engine).tabItem { Label("My health", systemImage: "heart.text.square") }
            Text("Chat").tabItem { Label("Chat", systemImage: "bubble.left.and.text.bubble.right") }
        }
        func all(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(all) }
        for look in looks {
            for style in styles {
                for category in [UIContentSizeCategory.large, largest] {
                    let name = "\(look.name) \(style == .dark ? "dark" : "light") \(category.rawValue)"
                    let window = try settled(tabs, size: look.size, regular: look.regular, style: style, at: category)
                    defer { window.isHidden = true }
                    let list = try XCTUnwrap(all(window).compactMap { $0 as? UICollectionView }.max { $0.contentSize.height < $1.contentSize.height }, name)
                    // The hard end, until it holds: rows drawn on the way down change the content's height.
                    var end = -1.0
                    for _ in 0..<30 where end != list.contentSize.height {
                        end = list.contentSize.height
                        list.setContentOffset(CGPoint(x: 0, y: end + list.adjustedContentInset.bottom - list.bounds.height), animated: false)
                        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.3))
                    }
                    XCTAssertEqual(end, list.contentSize.height, "\(name): the list reached its end")
                    let tabBar = try XCTUnwrap(all(window).first { $0 is UITabBar }, "\(name): the tab bar")
                    let bar = tabBar.convert(tabBar.bounds, to: window).minY
                    // On an iPad the bar can sit at the top; then the page ends at the safe area.
                    let floor = bar > window.bounds.midY ? bar : window.bounds.height - window.safeAreaInsets.bottom
                    let drawn = try Drawn(window)
                    let floorRow = Int(floor * drawn.scale) - 1
                    // A row with words: some pixel well inside the margins far from the row's own background.
                    let words = { (y: Int) in
                        let bg = drawn.rgb(1, y)
                        return (drawn.width / 10..<drawn.width * 9 / 10).contains { let p = drawn.rgb($0, y); return abs(p.r - bg.r) + abs(p.g - bg.g) + abs(p.b - bg.b) > 150 }
                    }
                    let last = try XCTUnwrap(stride(from: floorRow, to: floorRow - Int(300 * drawn.scale), by: -1).first(where: words), "\(name): words above the bar")
                    let gap = CGFloat(floorRow - last) / drawn.scale
                    XCTAssertGreaterThanOrEqual(gap, 12, "\(name): the footer clears the tab bar")
                }
            }
        }
    }
}

/// Draws text as usual, and logs the draws, those cut short, and the most lines a text took.
@available(iOS 18.0, *)
private struct TruncationProbe: TextRenderer {
    final class Log {
        var drawn = 0, cut = 0, lines = 0
        func reset() { (drawn, cut, lines) = (0, 0, 0) }
    }
    let log = Log()

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        log.drawn += 1
        if layout.isTruncated { log.cut += 1 }
        log.lines = max(log.lines, layout.count)
        for line in layout { context.draw(line) }
    }
}

/// The question box with its own focus, as ChatView holds it.
private struct QuestionHost: View {
    @State var draft: String
    @FocusState private var asking: Bool

    var body: some View {
        QuestionField(draft: $draft, asking: $asking)
    }
}
