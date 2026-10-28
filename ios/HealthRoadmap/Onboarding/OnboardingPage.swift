import SwiftUI

/// One onboarding screen (US-54, OnboardingView): symbol, title, one line on why, the
/// control, then the buttons.
struct OnboardingPage<Content: View, Actions: View>: View {
    let symbol: String
    let tint: Color
    let title: String
    let detail: String
    let progress: OnboardingStep?
    var fromHealth = false
    var message: String?
    /// Shares the screen's height between the heading and the content, so a short page
    /// leaves no gap above its buttons (Brad 2026-10-23).
    var spread = false
    @ViewBuilder let content: () -> Content
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        VStack(spacing: 0) {
            if let progress, let index = OnboardingStep.questions.firstIndex(of: progress) {
                ProgressView(value: Double(index + 1), total: Double(OnboardingStep.questions.count))
                    .accessibilityLabel("Question \(index + 1) of \(OnboardingStep.questions.count)")
                    .padding(.bottom, 12)
            }
            GeometryReader { screen in
                ScrollView {
                    VStack(spacing: 14) {
                        if spread { Spacer(minLength: 0) }
                        Image(systemName: symbol)
                            .font(.system(size: 44))
                            .foregroundStyle(tint)
                            .padding(.top, 24)
                            .accessibilityHidden(true)
                        Text(title)
                            .font(.title.bold())
                            .multilineTextAlignment(.center)
                            .accessibilityAddTraits(.isHeader)
                        Text(detail)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        if fromHealth {
                            Label("From Apple Health", systemImage: "heart.fill")
                                .font(.footnote)
                                .foregroundStyle(.pink)
                        }
                        if spread { Spacer(minLength: 12).frame(maxHeight: 48) }
                        content().padding(.top, spread ? 0 : 12)
                        if spread { Spacer(minLength: 0) }
                    }
                    .frame(maxWidth: .infinity, minHeight: spread ? screen.size.height : nil)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
            VStack(spacing: 6) {
                // The engine's own words for a refused answer (AC5).
                if let message {
                    Text(message).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
                }
                actions()
            }
            .padding(.top, 12)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
    }
}

extension OnboardingPage where Actions == EmptyView {
    /// A page whose control is its answer (sex): no buttons.
    init(symbol: String, tint: Color, title: String, detail: String, progress: OnboardingStep?, fromHealth: Bool, message: String?,
         @ViewBuilder content: @escaping () -> Content) {
        self.init(symbol: symbol, tint: tint, title: title, detail: detail, progress: progress, fromHealth: fromHealth, message: message,
                  content: content, actions: { EmptyView() })
    }
}
