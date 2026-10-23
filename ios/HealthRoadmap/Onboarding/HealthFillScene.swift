import SwiftUI

/// The Apple Health step's picture (Brad 2026-10-23: "we want people to click
/// select all and then allow as easily as possible, without having to think"):
/// a small drawing of Apple's Health Access sheet showing the two taps it needs.
/// "Turn On All" switches on and the switches below follow, then "Allow" lights.
/// Apple's sheet is the system's: an app cannot rename its controls, turn its
/// switches on or press them, so this shows the way through it. Loops; under
/// Reduce Motion it shows the end state, still. VoiceOver reads the two steps.
struct HealthFillScene: View {
    /// 0 off, 1 Turn On All on, 2 every switch on, 3 Allow lit.
    @State private var stage = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let rows = ["Weight", "Blood Pressure", "Height", "Waist Circumference"]

    var body: some View {
        VStack(spacing: 14) {
            VStack(spacing: 0) {
                HStack {
                    Text("Don't Allow").foregroundStyle(.secondary)
                    Spacer()
                    Text("Health Access").fontWeight(.semibold)
                    Spacer()
                    Text("Allow")
                        .fontWeight(.semibold)
                        .foregroundStyle(stage >= 3 ? Color.white : Color.secondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 5)
                        .background(stage >= 3 ? Color.blue : Color.clear, in: Capsule())
                }
                .font(.footnote)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                Divider()
                row("Turn On All", on: stage >= 1, strong: true)
                    .background(stage == 1 ? Color.blue.opacity(0.08) : Color.clear)
                Divider().padding(.leading, 14)
                ForEach(Self.rows, id: \.self) { name in
                    row(name, on: stage >= 2, strong: false)
                    if name != Self.rows.last { Divider().padding(.leading, 14) }
                }
            }
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color(uiColor: .separator), lineWidth: 0.5))
            .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
            .accessibilityHidden(true)

            HStack(spacing: 18) {
                step(1, "Tap **Turn On All**", lit: stage >= 1 && stage < 3)
                step(2, "Tap **Allow**", lit: stage >= 3)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("On Apple's Health Access screen, tap Turn On All, then Allow.")
        }
        .task { await play() }
    }

    private func row(_ name: String, on: Bool, strong: Bool) -> some View {
        HStack {
            Text(name).font(.subheadline.weight(strong ? .semibold : .regular))
            Spacer()
            Toggle("", isOn: .constant(on)).labelsHidden().tint(.green).allowsHitTesting(false)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
    }

    private func step(_ number: Int, _ text: LocalizedStringKey, lit: Bool) -> some View {
        HStack(spacing: 8) {
            Text("\(number)")
                .font(.footnote.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(lit ? Color.accentColor : Color.secondary.opacity(0.5), in: Circle())
            Text(text).font(.subheadline)
        }
        .scaleEffect(lit && !reduceMotion ? 1.05 : 1)
    }

    /// Turn On All, the switches after it, then Allow; a rest, then again.
    private func play() async {
        if reduceMotion {
            stage = 3
            return
        }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(0.8))
            for next in 1...3 {
                withAnimation(.spring(duration: 0.45, bounce: 0.3)) { stage = next }
                try? await Task.sleep(for: .seconds(next == 1 ? 0.5 : 0.9))
            }
            try? await Task.sleep(for: .seconds(1.8))
            withAnimation(.easeOut(duration: 0.4)) { stage = 0 }
        }
    }
}

#Preview { HealthFillScene().padding() }
