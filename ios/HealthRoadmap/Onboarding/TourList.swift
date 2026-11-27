import SwiftUI

extension View {
    /// My health's list, as the tour sees it (US-57 AC2): on screen or not, moving or at rest,
    /// where it is scrolled, and the anchors this record draws (`targets`). It is the tour's door
    /// to scroll an anchor into view and to open the lab upload.
    func tourList(proxy: ScrollViewProxy, targets: [TourStep: TourTarget], covered: Bool,
                  openLabUpload: @escaping () -> Void) -> some View {
        modifier(TourList(proxy: proxy, targets: targets, covered: covered, openLabUpload: openLabUpload))
    }
}

private struct TourList: ViewModifier {
    let proxy: ScrollViewProxy
    let targets: [TourStep: TourTarget]
    /// A sheet or alert is up over the list: a tip waits for it to go.
    let covered: Bool
    let openLabUpload: () -> Void
    @Environment(TourGuide.self) private var tour: TourGuide?
    /// On screen: its tab shows and nothing is pushed over it.
    @State private var appeared = false

    private var shown: Bool { appeared && !covered }

    func body(content: Content) -> some View {
        content
            // Already inside the status bar and the tab bar: the rect the list shows rows in (measured).
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { tour?.listBounds($0) }
            .onScrollReports(running: tour?.isLive ?? false) { tour?.listMoving($0) } scrolled: { tour?.listScrolled($0) }
            .onAppear {
                wire()
                appeared = true
            }
            .onDisappear { appeared = false }
            .onChange(of: shown, initial: true) { tour?.listShown(shown) }
            .onChange(of: targets, initial: true) { tour?.targets(targets) }
    }

    /// The scroll the tour asks for, animated: a lazy list only reaches a row it has not drawn
    /// yet by animating to it (an instant jump lands short and the row is never drawn, measured).
    /// The scroll phase does not report a scroll the app starts, so the tour sees its end in the
    /// scroll geometry (`TourSight.arrived`), never on a clock.
    private func wire() {
        tour?.scroll = { [proxy] target in
            withAnimation { proxy.scrollTo(target.id, anchor: target.atTop ? .top : .center) }
        }
        tour?.openLabUpload = openLabUpload
    }
}

private extension View {
    /// iOS 18 says when the person or iOS scrolls the list, and where it is scrolled; before it,
    /// neither is known.
    /// `running`: a finished tour reads a constant, so no report fires on each scroll frame.
    @ViewBuilder func onScrollReports(running: Bool, _ moving: @escaping (Bool) -> Void, scrolled: @escaping (TourScroll) -> Void) -> some View {
        if #available(iOS 18, *) {
            onScrollPhaseChange { _, phase in moving(phase != .idle) }
                .onScrollGeometryChange(for: TourScroll?.self) { geometry in
                    guard running else { return nil }
                    let insets = geometry.contentInsets
                    let lowest = -insets.top
                    let highest = max(lowest, geometry.contentSize.height + insets.bottom - geometry.containerSize.height)
                    return TourScroll(offset: geometry.contentOffset.y, range: lowest...highest)
                } action: { _, scroll in if let scroll { scrolled(scroll) } }
        } else {
            self
        }
    }
}
