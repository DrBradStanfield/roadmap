import SwiftUI

/// The new-user flow's Apple Health page (US-54 AC3).
extension OnboardingView {
    /// The Apple Health page (AC3), built here so TextSizeLayoutTests lays out the real one.
    /// One button, Continue, and Apple's sheet always follows (App Review 5.1.1(iv), 2026-11-09):
    /// a person who does not want to share says so in Apple's sheet.
    static func healthPage(connecting: Bool, allow: @escaping () -> Void) -> some View {
        OnboardingPage(symbol: "heart.fill", tint: .pink, title: "Use your Apple Health data",
             detail: "So you type less. Your sex, birth date, height, weight, waist and blood pressure go only into your record, on this iPhone or in your own cloud. Values you add here are saved back to Apple Health.",
             progress: nil, spread: true) {
            VStack(spacing: 12) {
                HealthFillScene()
                // US-56's five, named too (adversary R5): the sheet asks for them as well.
                Text(liveLine).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                AppleAsksNext(inPage: true)
            }
        } actions: {
            AppleAsksNext()
            primary(connecting ? "Connecting…" : "Continue", id: "onboarding.allow", action: allow)
                .disabled(connecting)
        }
    }

    /// The last thing read before the tap: what Apple's sheet asks next (AC3; words Brad 2026-11-09).
    /// A hint, never a switch: no app can turn that sheet's switches on. In the accent
    /// green, not pink: red read as something wrong (Brad 2026-10-25). Primary text on the
    /// 12% wash; the icon in the accent clears 3:1 on it in both modes. Above the buttons,
    /// except at accessibility sizes, where it would push them off an SE: there it ends the
    /// scrolling page (US-54 AC8b).
    private struct AppleAsksNext: View {
        var inPage = false
        @Environment(\.dynamicTypeSize) private var textSize

        var body: some View {
            if textSize.isAccessibilitySize == inPage { hint }
        }

        private var hint: some View {
            Label {
                Text(LocalizedStringKey(OnboardingView.appleAsksNextWords))
            } icon: {
                Image(systemName: "hand.tap.fill").foregroundStyle(Color.accentColor)
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .padding(.bottom, 6)
            .accessibilityElement(children: .combine)
        }
    }

    static let appleAsksNextWords = "Next, Apple asks which data to share."
    /// The five US-56 readings, named on the Apple Health page (adversary R5).
    static let liveLine = "It also shows your resting heart rate, sleep, VO2 max and steps here, never in your record."
}
