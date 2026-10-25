#if DEBUG
import HealthKit

/// DEBUG only, never in a release build: with `--seed-live-health`, writes synthetic heart
/// rate, resting heart rate, sleep with stages, VO2 max and steps into the simulator's
/// Health store, so US-56's cards and pages can be checked against data (ios/architecture.md
/// D6). Asks to write the five types, which the shipped app never does (US-56 AC2, AC10).
enum LiveHealthSeed {
    static let argument = "--seed-live-health"

    static func runIfAsked() {
        guard ProcessInfo.processInfo.arguments.contains(argument), HKHealthStore.isHealthDataAvailable() else { return }
        // After launch settles: a sheet asked for while the launch view swaps out is dismissed.
        Task.detached {
            try? await Task.sleep(for: .seconds(4))
            try? await seed()
        }
    }

    @concurrent
    private static func seed() async throws {
        let store = HKHealthStore()
        let types: Set<HKSampleType> = [HKQuantityType(.heartRate), HKQuantityType(.restingHeartRate), HKCategoryType(.sleepAnalysis),
                                        HKQuantityType(.vo2Max), HKQuantityType(.stepCount)]
        try await store.requestAuthorization(toShare: types, read: types)
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: .now)
        let bpm = HKUnit.count().unitDivided(by: .minute())
        let vo2 = HKUnit.literUnit(with: .milli).unitDivided(by: .gramUnit(with: .kilo).unitMultiplied(by: .minute()))
        var samples: [HKSample] = []
        func quantity(_ id: HKQuantityTypeIdentifier, _ value: Double, _ unit: HKUnit, _ start: Date, _ end: Date) {
            guard start < .now else { return }
            samples.append(HKQuantitySample(type: HKQuantityType(id), quantity: HKQuantity(unit: unit, doubleValue: value), start: start, end: min(end, .now)))
        }
        for back in 0..<60 {
            let day = calendar.date(byAdding: .day, value: -back, to: today)!
            let wave = sin(Double(back) / 4)
            quantity(.restingHeartRate, 58 + 3 * wave, bpm, day.addingTimeInterval(7 * 3600), day.addingTimeInterval(7 * 3600))
            for hour in 7..<22 {
                let start = day.addingTimeInterval(Double(hour) * 3600)
                quantity(.stepCount, Double(200 + (hour * 37 + back * 53) % 900), .count(), start, start.addingTimeInterval(3600))
                for minute in stride(from: 0, to: 60, by: back < 7 ? 15 : 60) {
                    let at = start.addingTimeInterval(Double(minute) * 60)
                    quantity(.heartRate, 62 + Double((hour * 13 + minute + back * 7) % 60), bpm, at, at)
                }
            }
            for hour in [0, 3, 5] {
                let at = day.addingTimeInterval(Double(hour) * 3600)
                quantity(.heartRate, 50 + Double((hour + back) % 6), bpm, at, at)
            }
            // A night of stages ending this morning, as a watch records it.
            var at = day.addingTimeInterval(-3600 + Double(back % 3) * 900)
            for (stage, minutes) in [(HKCategoryValueSleepAnalysis.asleepCore, 40), (.asleepDeep, 50), (.asleepCore, 60), (.asleepREM, 25), (.awake, 5),
                                     (.asleepCore, 70), (.asleepDeep, 30), (.asleepREM, 40), (.asleepCore, 50), (.awake, 3), (.asleepREM, 35), (.asleepCore, 30)] {
                let end = at.addingTimeInterval(Double(minutes + back % 4) * 60)
                if end < .now { samples.append(HKCategorySample(type: HKCategoryType(.sleepAnalysis), value: stage.rawValue, start: at, end: end)) }
                at = end
            }
        }
        for week in 0..<52 {
            let day = calendar.date(byAdding: .day, value: -7 * week - 2, to: today)!.addingTimeInterval(18 * 3600)
            quantity(.vo2Max, 40 + 2 * sin(Double(week) / 5), vo2, day, day)
        }
        try await store.save(samples)
    }
}
#endif
