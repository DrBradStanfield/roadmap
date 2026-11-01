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

    /// The iPhone 17e's screen, the smallest current iPhone.
    private let iPhone17e = CGSize(width: 390, height: 844)

    /// How many times `view`'s texts were drawn, once settled, in a 17e-sized window at
    /// `category`, and how many of those draws were cut short with "…" (SwiftUI's own `Text.Layout.isTruncated`).
    @available(iOS 18.0, *)
    private func drawnTexts(in view: some View, at category: UIContentSizeCategory) throws -> (drawn: Int, cut: Int) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: iPhone17e)
        window.traitOverrides.preferredContentSizeCategory = category
        let probe = TruncationProbe()
        window.rootViewController = UIHostingController(rootView: view.textRenderer(probe))
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        // Long enough for `.task` to reveal a scene's rows and their springs to settle.
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 3))
        // Then count the settled page only: dark mode redraws every text where it lies.
        probe.log.drawn = 0
        probe.log.cut = 0
        window.traitOverrides.userInterfaceStyle = .dark
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.5))
        return (probe.log.drawn, probe.log.cut)
    }

    /// US-54 AC8b: the Apple Health page's title and words are whole on a 17e at the
    /// default and extra-large sizes; the page scrolls instead.
    @available(iOS 18.0, *)
    func testTheAppleHealthPageNeverCutsItsWords_US54_AC8b() throws {
        let page = NavigationStack {
            OnboardingPage(symbol: "heart.fill", tint: .pink, title: OnboardingView.healthTitle, detail: OnboardingView.healthDetail,
                           progress: nil, spread: true) {
                VStack(spacing: 12) {
                    HealthFillScene()
                    Text(OnboardingView.liveLine).font(.footnote).multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } actions: {
                Text(OnboardingView.appleAsksNextWords).padding(14)
                Button("Connect Apple Health") {}.buttonStyle(.accent)
                Button("Not now") {}
            }
        }
        for category in [UIContentSizeCategory.large, .extraLarge] {
            let texts = try drawnTexts(in: page, at: category)
            XCTAssertGreaterThan(texts.drawn, 5, "\(category.rawValue): the page drew its words")
            XCTAssertEqual(texts.cut, 0, "\(category.rawValue): no words end in …")
        }
    }

    /// US-54 AC8b: the welcome story's rows never cut a name short ("Blood pre…") at the
    /// largest size it shows (the welcome shows words alone at accessibility sizes).
    @available(iOS 18.0, *)
    func testTheWelcomeStoryNeverCutsARowShort_US54_AC8b() throws {
        // Framed and inset as WelcomeStory and WelcomeView place them.
        let numbers = NumbersScene().frame(height: 236).padding(.horizontal, 28)
        let plan = PlanScene().frame(height: 236).padding(.horizontal, 28)
        for category in [UIContentSizeCategory.large, .extraLarge, .extraExtraExtraLarge] {
            for (name, scene) in [("numbers", AnyView(numbers)), ("plan", AnyView(plan))] {
                let texts = try drawnTexts(in: scene, at: category)
                XCTAssertGreaterThan(texts.drawn, 5, "\(category.rawValue) \(name): the scene drew its rows")
                XCTAssertEqual(texts.cut, 0, "\(category.rawValue) \(name): no row ends in …")
            }
        }
    }
}

/// Draws text as usual and counts the texts drawn, and those cut short.
@available(iOS 18.0, *)
private struct TruncationProbe: TextRenderer {
    final class Log { var drawn = 0, cut = 0 }
    let log = Log()

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        log.drawn += 1
        if layout.isTruncated { log.cut += 1 }
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
