import SwiftUI

/// The welcome screen's story (Brad 2026-10-23), in place of the words it used to
/// list: numbers arrive, a plan is built from them, then the record settles on
/// this iPhone or the person's own Dropbox or Google Drive, never our servers.
/// Three scenes, looping, each under its own heading. Under Reduce Motion the
/// scenes cross-fade and their rows appear at once. VoiceOver reads one sentence
/// saying all three (App Review 1.4.1 asks the welcome to say where data lives).
/// The values are made up, in the region's units, and no scene gives advice.
struct WelcomeStory: View {
    /// The story in words: what VoiceOver reads, and what the welcome screen shows in its
    /// place at accessibility text sizes, where the scenes cannot fit.
    static let summary = "Add your numbers: Apple Health and lab reports can fill them in. Get your plan, built from published guidelines. Your data stays yours: on this iPhone or in your own Dropbox or Google Drive, never on our servers."
    @State private var scene = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            switch scene {
            case 0: NumbersScene().transition(move)
            case 1: PlanScene().transition(move)
            default: PrivateScene().transition(move)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .frame(height: 236)
        .background(
            LinearGradient(colors: [Color.accentColor.opacity(0.10), Color.accentColor.opacity(0.03)], startPoint: .top, endPoint: .bottom),
            in: RoundedRectangle(cornerRadius: 24, style: .continuous)
        )
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.summary)
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(reduceMotion ? 4.5 : 3.6))
                withAnimation(.smooth(duration: 0.5)) { scene = (scene + 1) % 3 }
            }
        }
    }

    private var move: AnyTransition {
        reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity),
                                              removal: .move(edge: .leading).combined(with: .opacity))
    }
}

/// A scene's heading, the step's symbol and words in the accent colour.
private struct Heading: View {
    let title: String
    let symbol: String
    var bounce = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Label(title, systemImage: symbol)
            .font(.headline)
            .foregroundStyle(.tint)
            .symbolEffect(.bounce, value: reduceMotion ? 0 : bounce)
    }
}

/// Values arrive one by one, as Apple Health or a lab report would fill them in.
private struct NumbersScene: View {
    @State private var shown = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let rows = Sample.rows

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Heading(title: "Add your numbers", symbol: "list.bullet.clipboard", bounce: shown)
            ForEach(rows.indices, id: \.self) { index in
                if index < shown {
                    let row = rows[index]
                    HStack(spacing: 10) {
                        Image(systemName: row.symbol).foregroundStyle(row.tint.softInDark).frame(width: 22)
                        Text(row.label).font(.subheadline)
                        Spacer()
                        Text(row.value).font(.subheadline.weight(.semibold)).monospacedDigit()
                        Text(row.unit).font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .plate(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .transition(.scale(scale: 0.85, anchor: .top).combined(with: .opacity))
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .task { await reveal($shown, count: rows.count, at: reduceMotion) }
    }
}

/// The plan builds itself: one step per area, each ticked as it lands.
private struct PlanScene: View {
    @State private var shown = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let steps = [("heart.fill", Color.red, "Blood pressure"), ("drop.fill", Color.blue, "Cholesterol"), ("scalemass.fill", Color.purple, "Weight")]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Heading(title: "Get your plan", symbol: "sparkles", bounce: shown)
            ForEach(steps.indices, id: \.self) { index in
                if index < shown {
                    let step = steps[index]
                    HStack(spacing: 10) {
                        Image(systemName: step.0).foregroundStyle(step.1.softInDark).frame(width: 22)
                        Text(step.2).font(.subheadline.weight(.medium))
                        Spacer()
                        Text("Next step").font(.caption).foregroundStyle(.secondary)
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .plate(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .task { await reveal($shown, count: steps.count, at: reduceMotion, first: 0.45) }
    }
}

/// The record settles on the phone and the person's own cloud, and a lock closes on it.
private struct PrivateScene: View {
    @State private var locked = false
    @State private var linked = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Heading(title: "Your data stays yours", symbol: "lock.shield")
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 0) {
                place("iphone", "This iPhone")
                Capsule()
                    .fill(Color.accentColor.opacity(0.5))
                    .frame(width: linked ? 60 : 0, height: 3)
                    .frame(width: 60)
                place("icloud.fill", "Dropbox or Google Drive")
            }
            .frame(maxWidth: .infinity)
            Label("Never on our servers", systemImage: locked ? "lock.fill" : "lock.open.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.tint)
                .contentTransition(.symbolEffect(.replace))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .plate(Capsule())
                .scaleEffect(locked ? 1 : 0.92)
                .frame(maxWidth: .infinity)
        }
        .padding(20)
        .task {
            if reduceMotion {
                linked = true
                locked = true
                return
            }
            try? await Task.sleep(for: .seconds(0.4))
            withAnimation(.easeInOut(duration: 0.6)) { linked = true }
            try? await Task.sleep(for: .seconds(0.7))
            withAnimation(.spring(duration: 0.4, bounce: 0.5)) { locked = true }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: locked) { _, new in new && !reduceMotion }
    }

    private func place(_ symbol: String, _ name: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 30))
                .foregroundStyle(.tint)
                .frame(width: 58, height: 58)
                .plate(RoundedRectangle(cornerRadius: 16, style: .continuous))
            Text(name).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(width: 110)
        }
    }
}

private extension View {
    /// A scene's raised plate: the system background with a soft shadow, light or dark.
    func plate(_ shape: some Shape) -> some View {
        background(Color(uiColor: .secondarySystemGroupedBackground), in: shape)
            .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
    }
}

/// Shows a scene's rows one after another; all at once under Reduce Motion.
@MainActor
private func reveal(_ shown: Binding<Int>, count: Int, at reduceMotion: Bool, first: Double = 0.2) async {
    if reduceMotion {
        shown.wrappedValue = count
        return
    }
    try? await Task.sleep(for: .seconds(first))
    for index in 1...count {
        withAnimation(.spring(duration: 0.45, bounce: 0.3)) { shown.wrappedValue = index }
        try? await Task.sleep(for: .seconds(0.4))
    }
}

/// Made-up values for the first scene, in the units this region reads.
private enum Sample {
    struct Row {
        let symbol: String
        let tint: Color
        let label: String
        let value: String
        let unit: String
    }

    static var rows: [Row] {
        let us = Locale.current.measurementSystem == .us
        return [
            Row(symbol: "scalemass.fill", tint: .purple, label: "Weight", value: us ? "164" : "74.2", unit: us ? "lb" : "kg"),
            Row(symbol: "heart.fill", tint: .red, label: "Blood pressure", value: "124/80", unit: "mmHg"),
            Row(symbol: "drop.fill", tint: .blue, label: "LDL", value: us ? "112" : "2.9", unit: us ? "mg/dL" : "mmol/L"),
        ]
    }
}

#Preview { WelcomeStory().padding() }
