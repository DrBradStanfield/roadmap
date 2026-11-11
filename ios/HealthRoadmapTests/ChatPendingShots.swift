import SwiftUI
import XCTest
@testable import HealthRoadmap

/// US-52 AC6g design shots: the pending line under a made-up question, at the iPhone SE's
/// width (375 pt), light and dark. Opt-in: TEST_RUNNER_THINKING_SHOTS=<folder> writes the
/// PNGs there; any other run skips. Run it again with Reduce Motion on in the simulator for
/// the still indicator (the files then end "-reduce-motion"). No server, no real chat.
@MainActor
final class ChatPendingShots: XCTestCase {
    func testShootThePendingLine_US52_AC6g() throws {
        guard let folder = ProcessInfo.processInfo.environment["THINKING_SHOTS"] else {
            throw XCTSkip("Set TEST_RUNNER_THINKING_SHOTS=<folder> to write the design shots.")
        }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let question = ChatLine(role: .user, text: "Is my LDL OK?")
        let answer = ChatLine(role: .assistant, text: "Your LDL is above the target for your risk. A repeat test in three months")
        let motion = UIAccessibility.isReduceMotionEnabled ? "-reduce-motion" : ""
        for (name, lines, words) in [("thinking", [question], "Thinking…"), ("answering", [question, answer], "Answering…")] {
            for style in [UIUserInterfaceStyle.light, .dark] {
                let page = VStack(alignment: .leading, spacing: 12) {
                    ForEach(lines) { ChatBubble(line: $0) }
                    ChatPendingLine(words: words)
                    Spacer()
                }
                .padding()
                let host = UIHostingController(rootView: page)
                host.view.backgroundColor = .systemBackground
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: 375, height: 280)
                window.overrideUserInterfaceStyle = style
                window.rootViewController = host
                window.isHidden = false
                RunLoop.main.run(until: .now.addingTimeInterval(0.5))
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let file = URL(fileURLWithPath: folder).appending(path: "\(name)-\(style == .dark ? "dark" : "light")\(motion).png")
                try XCTUnwrap(image.pngData()).write(to: file)
                window.isHidden = true
            }
        }
    }
}
