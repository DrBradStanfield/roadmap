import SwiftUI

/// The welcome screen's story (Brad 2026-10-23): numbers arrive, a plan is built
/// from them, then the record locks to this iPhone or the person's own cloud.
/// Three scenes, looping; the welcome screen lights the matching point below as
/// each one plays. Under Reduce Motion the scenes only cross-fade. Hidden from
/// VoiceOver: the points below say the same in words. The values are made up,
/// in the region's units, and no scene gives advice.
struct WelcomeStory: View {
    /// The scene playing: 0 numbers, 1 plan, 2 private.
    @Binding var scene: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            switch scene {
            case 0: NumbersScene().transition(move)
            case 1: PlanScene().transition(move)
            default: PrivateScene().transition(move)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 196)
        .background(
            LinearGradient(colors: [Color.accentColor.opacity(0.10), Color.accentColor.opacity(0.03)], startPoint: .top, endPoint: .bottom),
            in: RoundedRectangle(cornerRadius: 24, style: .continuous)
        )
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .accessibilityHidden(true)
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(reduceMotion ? 4.5 : 3.4))
                withAnimation(.smooth(duration: 0.5)) { scene = (scene + 1) % 3 }
            }
        }
    }

    private var move: AnyTransition {
        reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity),
                                              removal: .move(edge: .leading).combined(with: .opacity))
    }
}

/// Values arrive one by one, as Apple Health or a lab report would fill them in.
private struct NumbersScene: View {
    @State private var shown = 0
    private let rows = Sample.rows

    var body: some View {
        VStack(spacing: 8) {
            ForEach(rows.indices, id: \.self) { index in
                if index < shown {
                    let row = rows[index]
                    HStack(spacing: 10) {
                        Image(systemName: row.symbol)
                            .foregroundStyle(row.tint)
                            .frame(width: 22)
                        Text(row.label).font(.subheadline)
                        Spacer()
                        Text(row.value).font(.subheadline.weight(.semibold)).monospacedDigit()
                        Text(row.unit).font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
                    .transition(.scale(scale: 0.85, anchor: .top).combined(with: .opacity))
                }
            }
        }
        .padding(.horizontal, 20)
        .task { await reveal($shown, count: rows.count) }
    }
}

/// The plan builds itself: a sparkle, then one step per area, each ticked as it lands.
private struct PlanScene: View {
    @State private var shown = 0
    private let steps = [("heart.fill", Color.red, "Blood pressure"), ("drop.fill", Color.blue, "Cholesterol"), ("scalemass.fill", Color.purple, "Weight")]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Your plan", systemImage: "sparkles")
                .font(.headline)
                .foregroundStyle(.tint)
                .symbolEffect(.bounce, value: shown)
            ForEach(steps.indices, id: \.self) { index in
                if index < shown {
                    let step = steps[index]
                    HStack(spacing: 10) {
                        Image(systemName: step.0).foregroundStyle(step.1).frame(width: 22)
                        Text(step.2).font(.subheadline.weight(.medium))
                        Spacer()
                        Text("Next step").font(.caption).foregroundStyle(.secondary)
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .transition(.scale.combined(with: .opacity))
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
        }
        .padding(.horizontal, 20)
        .task { await reveal($shown, count: steps.count, first: 0.45) }
    }
}

/// The record settles on the phone and the person's own cloud, and a lock closes on it.
private struct PrivateScene: View {
    @State private var locked = false
    @State private var linked = false

    var body: some View {
        VStack(spacing: 14) {
            HStack(spacing: 0) {
                place("iphone", "Your iPhone")
                Capsule()
                    .fill(Color.accentColor.opacity(0.5))
                    .frame(width: linked ? 70 : 0, height: 3)
                    .frame(width: 70)
                place("icloud.fill", "Your cloud")
            }
            Label("Never on our servers", systemImage: locked ? "lock.fill" : "lock.open.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.tint)
                .contentTransition(.symbolEffect(.replace))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Color(uiColor: .systemBackground), in: Capsule())
                .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
                .scaleEffect(locked ? 1 : 0.92)
        }
        .task {
            try? await Task.sleep(for: .seconds(0.4))
            withAnimation(.easeInOut(duration: 0.6)) { linked = true }
            try? await Task.sleep(for: .seconds(0.7))
            withAnimation(.spring(duration: 0.4, bounce: 0.5)) { locked = true }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: locked) { _, new in new }
    }

    private func place(_ symbol: String, _ name: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 34))
                .foregroundStyle(.tint)
                .frame(width: 64, height: 64)
                .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
            Text(name).font(.caption).foregroundStyle(.secondary)
        }
    }
}

/// Shows a scene's rows one after another.
@MainActor
private func reveal(_ shown: Binding<Int>, count: Int, first: Double = 0.2) async {
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

#Preview { WelcomeStory(scene: .constant(0)).padding() }
