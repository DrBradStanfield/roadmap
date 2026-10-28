#if DEBUG
import Darwin
import Foundation
import os

/// Debug builds only, and only when the launch argument `-mainWatchdogLog <path>` names a
/// log: watches the main thread, which is for UI alone (Brad 2026-10-22, US-25 AC21c).
/// A background thread pings main every 50 ms; when main took 100 ms or more to answer,
/// it appends "<timestamp> main stalled N ms" to that file. A tool for timing by hand,
/// not a test: the rule itself is enforced by the compiler and the engine's precondition.
enum MainThreadWatchdog {
    /// The launch argument that names the log file, followed by its path.
    static let fileArgument = "-mainWatchdogLog"
    /// Main may stay away this long before it counts as stalled.
    static let threshold: Duration = .milliseconds(100)

    /// Starts on launch, if the argument names a log; otherwise does nothing.
    static func start(arguments: [String] = ProcessInfo.processInfo.arguments) {
        guard let index = arguments.firstIndex(of: fileArgument), arguments.indices.contains(index + 1) else { return }
        let file = URL(fileURLWithPath: arguments[index + 1])
        FileManager.default.createFile(atPath: file.path, contents: nil)
        let thread = Thread { watch(file) }
        thread.name = "main-watchdog"
        thread.qualityOfService = .userInteractive
        thread.start()
    }

    private static func watch(_ file: URL) {
        let clock = ContinuousClock()
        let answered = OSAllocatedUnfairLock(initialState: UInt64(0))
        while true {
            var sent = clock.now
            var tick = sent
            let ping = DispatchTime.now().uptimeNanoseconds
            DispatchQueue.main.async { answered.withLock { $0 = ping } }
            while answered.withLock({ $0 }) != ping {
                Thread.sleep(forTimeInterval: 0.005)
                // This thread did not run either (the app was suspended, or a debugger
                // paused it): not main's stall, so the wait starts again.
                if clock.now - tick > .milliseconds(50) { sent = clock.now }
                tick = clock.now
            }
            let stalled = clock.now - sent
            if stalled >= threshold { report(stalled, to: file) }
            Thread.sleep(forTimeInterval: 0.05)
        }
    }

    private static func report(_ stalled: Duration, to file: URL) {
        let line = "\(Date.now.formatted(.iso8601)) main stalled \(Int(stalled / .milliseconds(1))) ms\n"
        guard let handle = try? FileHandle(forWritingTo: file) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: Data(line.utf8))
    }
}

/// Debug builds only: milliseconds since the process started, logged at the launch's
/// milestones, so a change to launch can be timed (US-25 AC21).
enum LaunchClock {
    private static let log = Logger(subsystem: "com.drstanfield.healthroadmap", category: "launch")

    static func mark(_ milestone: String) {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return }
        let start = info.kp_proc.p_un.__p_starttime
        let ms = (Date().timeIntervalSince1970 - (Double(start.tv_sec) + Double(start.tv_usec) / 1e6)) * 1000
        log.notice("launch: \(milestone, privacy: .public) at \(Int(ms), privacy: .public) ms")
    }
}
#endif
