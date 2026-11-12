import XCTest
@testable import HealthRoadmap

/// The helpers CloudSyncTests and CloudConnectionPinsTests share: engine-made
/// records, the active days they hold, a wait on the store's draw, and stubbed
/// sign-ins. Moved from CloudSyncTests unchanged (survey S3 pins, 2026-11-12).
@MainActor
protocol CloudFixtures: XCTestCase {}

extension CloudFixtures {
    /// A record from the engine with one weight row per day, written by `device`.
    func record(days: [String], device: String) throws -> [String: Any] {
        let now = try! Date("2026-10-21T08:00:00.000Z", strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        let engine = try HealthEngine()
        var json = try engine.blocking { [now] in try $0.newRecord(now: now, deviceId: device, locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        for day in days {
            json = try XCTUnwrap(engine.blocking { [now] in try $0.apply(.add(metric: "weight", value: 80, day: day), to: json, now: now, deviceId: device) }.record)
        }
        return try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    }

    func activeDays(_ record: [String: Any]) -> [String] {
        ((record["measurements"] as? [[String: Any]]) ?? [])
            .filter { $0["status"] as? String == "active" }
            .compactMap { ($0["recordedAt"] as? String).map { String($0.prefix(10)) } }
            .sorted()
    }

    func activeDays(_ json: String) -> [String] {
        activeDays(try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any])
    }

    /// Waits until the store has drawn what `done` checks: re-checked on each change the
    /// store makes, never on a fixed timing. Fails after `timeout` with no change.
    func drawn(_ store: RecordStore, timeout: TimeInterval = 5, _ done: @escaping @MainActor () -> Bool) async {
        while !done() {
            let changed = XCTestExpectation(description: "the store draws the cloud's news")
            withObservationTracking { _ = store.revision; _ = store.myData } onChange: { changed.fulfill() }
            if done() { return } // drawn between the check and the tracking
            let waited = await XCTWaiter().fulfillment(of: [changed], timeout: timeout)
            guard waited == .completed else { return XCTFail("the store never drew the cloud's news") }
        }
    }

    func signIn() -> OAuthClient.Authenticate {
        { url, _ in
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
            return URL(string: "db-xf96vqvjotm5xhx://2/token?code=c&state=\(state)")!
        }
    }

    /// A sign-in sheet held open: the browser step returns only after `release()`.
    func heldSignIn() -> (authenticate: OAuthClient.Authenticate, shown: AsyncStream<Void>, release: () -> Void) {
        let (shown, show) = AsyncStream.makeStream(of: Void.self)
        let (released, release) = AsyncStream.makeStream(of: Void.self)
        let authenticate: OAuthClient.Authenticate = { url, scheme in
            show.yield()
            for await _ in released { break }
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
            let redirect = CloudProvider.allCases.first { $0.callbackScheme == scheme }!.redirectURI
            return URL(string: "\(redirect)?code=c&state=\(state)")!
        }
        return (authenticate, shown, { release.yield() })
    }
}
