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
    /// most lines one text took.
    @available(iOS 18.0, *)
    private func drawnTexts(in view: some View, at category: UIContentSizeCategory, screen: CGSize) throws -> TruncationProbe.Log {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: screen)
        window.traitOverrides.preferredContentSizeCategory = category
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
        await edits.take(try JSONDecoder().decode(OpaqueJSON.self, from: Data(proposals.utf8)), asked: store.chatMark, today: "2026-11-02")
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
        let page = NavigationStack { OnboardingView.healthPage(connecting: false, allow: {}, notNow: {}) }
        for screen in screens {
            for category in sizes {
                let texts = try drawnTexts(in: page, at: category, screen: screen.size)
                XCTAssertGreaterThan(texts.drawn, 5, "\(screen.name) \(category.rawValue): the page drew its words")
                XCTAssertEqual(texts.cut, 0, "\(screen.name) \(category.rawValue): no words end in …")
            }
        }
    }

    /// US-54 AC8: at accessibility sizes the real Apple Health page keeps its buttons on
    /// screen and at least 120 pt for its scrolling words, on an SE and a 17e. The scroll
    /// region gets only what the buttons leave, so a block of buttons too tall for the
    /// screen squeezes it to nothing and pushes "Not now" off the bottom.
    func testTheAppleHealthPageKeepsRoomToScrollAboveItsButtons_US54_AC8() throws {
        for screen in screens {
            let room = CGSize(width: screen.size.width, height: screen.size.height - screen.insets)
            for category in [UIContentSizeCategory.accessibilityExtraLarge, .accessibilityExtraExtraExtraLarge] {
                let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(origin: .zero, size: room)
                window.traitOverrides.preferredContentSizeCategory = category
                let host = UIHostingController(rootView: NavigationStack { OnboardingView.healthPage(connecting: false, allow: {}, notNow: {}) })
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
    /// width, drawn in light mode at the window's top left at `category`.
    private func inkAndRed(_ view: some View, at category: UIContentSizeCategory) throws -> (ink: ClosedRange<CGFloat>?, red: ClosedRange<CGFloat>?, redWidth: CGFloat?) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: CGSize(width: phone.width, height: 300))
        window.overrideUserInterfaceStyle = .light
        window.traitOverrides.preferredContentSizeCategory = category
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
