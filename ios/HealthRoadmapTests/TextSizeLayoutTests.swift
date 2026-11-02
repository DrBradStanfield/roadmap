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

    /// US-25 AC17g: at the largest size the Vitals "+" and Sync go under the title, so
    /// "Vitals" never breaks mid-word beside them; at the default size it is one row.
    func testTheVitalsHeaderStacksItsButtonsAtTheLargestSize_US25_AC17g() throws {
        let width = phone.width - 40 // the list's margins
        func height(_ view: some View, at category: UIContentSizeCategory) throws -> CGFloat {
            try measure(view, at: category, width: width).height
        }
        let header = ControlsHeader(title: .vitals()) { HeaderButtons() }
        let buttons = HStack(spacing: 14) { HeaderButtons() }.labelStyle(.iconOnly).font(.title3)
        let title = SectionTitle.vitals().fixedSize()

        // Exactly a one-line title over the buttons: a title broken beside them
        // ("Vi-tals" on two lines) gives a height close to this, but not equal.
        let largest = try height(header, at: self.largest)
        XCTAssertEqual(largest, try height(title, at: self.largest) + 8 + height(buttons, at: self.largest), accuracy: 0.5,
                       "the buttons sit under the whole title")
        let normal = try height(header, at: .large)
        XCTAssertLessThan(normal, try height(title, at: .large) + height(buttons, at: .large),
                          "at the default size title and buttons share a row")
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

/// The Vitals header's controls, as MyDataView shows them.
private struct HeaderButtons: View {
    var body: some View {
        Button {} label: { Label("Add medical records", systemImage: "plus") }
        Button {} label: { Label("Sync", systemImage: "icloud") }
    }
}
