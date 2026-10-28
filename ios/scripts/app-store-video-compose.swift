// Builds the App Store videos from the screen recording app-store-video.sh made (AVFoundation and
// Core Graphics only: no ffmpeg, no new dependency). Every picture of the app is a frame of that
// recording; the captions, the headline, the brand background, the phone outlines and the
// fictional paper report are drawn here.
//   compose preview <raw.mp4> <marks.txt> <out.mp4> [chat clip]   the 886 × 1920 app preview
//   compose header  <raw.mp4> <marks.txt> <out dir>                the 3840 × 1646 header, its stills
// marks.txt holds "VIDEO-MARK <beat> <unix seconds>" lines; "recording" is the recording's start.
import AppKit
import AVFoundation
import CoreImage
import CoreText

// MARK: Brand (ios/HealthRoadmap/Assets.xcassets)

let accent = CGColor(srgbRed: 0.043, green: 0.478, blue: 0.333, alpha: 1)      // AccentColor
let accentDeep = CGColor(srgbRed: 0.020, green: 0.290, blue: 0.200, alpha: 1)  // the same hue, darker, for depth
let accentLight = CGColor(srgbRed: 0.200, green: 0.820, blue: 0.560, alpha: 1) // AccentColor, dark appearance
let onAccent = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)                // OnAccent
let launchBackground = CGColor(srgbRed: 0.949, green: 0.949, blue: 0.969, alpha: 1) // LaunchBackground

// MARK: Easing

func clamp(_ x: Double, _ a: Double = 0, _ b: Double = 1) -> Double { min(max(x, a), b) }
func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }
func lerp(_ a: CGPoint, _ b: CGPoint, _ t: Double) -> CGPoint { CGPoint(x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t)) }
/// 0 → 1 over [start, start + length].
func phase(_ t: Double, _ start: Double, _ length: Double) -> Double { clamp((t - start) / length) }
func easeInOut(_ x: Double) -> Double { x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2 }
func easeOut(_ x: Double) -> Double { 1 - pow(1 - x, 3) }
/// A damped spring from 0 to 1 with a small overshoot, settled by x = 1.
func spring(_ x: Double) -> Double {
    if x <= 0 { return 0 }
    if x >= 1 { return 1 }
    return 1 - exp(-6 * x) * cos(9 * x) * (1 - x)
}

// MARK: The recording

func readMarks(_ path: String) -> [String: Double] {
    var raw: [String: Double] = [:]
    for line in (try! String(contentsOfFile: path, encoding: .utf8)).split(separator: "\n") {
        let parts = line.split(separator: " ")
        if parts.count == 3, let value = Double(parts[2]) { raw[String(parts[1])] = value }
    }
    guard let start = raw["recording"] else { fatalError("marks.txt has no recording line") }
    return raw.mapValues { $0 - start }
}

/// Frames of a recording by time, decoded in order (random access into a screen recording's long
/// GOPs is far too slow). Asking for an earlier time restarts the reader there.
final class Footage {
    let asset: AVURLAsset
    let duration: Double
    let size: CGSize
    private let maxHeight: CGFloat?
    /// Paints over each decoded frame (source pixels, top-left origin), e.g. a status bar fix.
    var touchUp: ((CGContext, CGImage) -> Void)?
    private var reader: AVAssetReader?
    private var output: AVAssetReaderTrackOutput?
    private var current: (time: Double, image: CGImage)?
    private var next: (time: Double, image: CGImage)?

    init(_ url: URL, maxHeight: CGFloat? = nil) {
        asset = AVURLAsset(url: url)
        let track = asset.tracks(withMediaType: .video).first!
        let natural = track.naturalSize.applying(track.preferredTransform)
        size = CGSize(width: abs(natural.width), height: abs(natural.height))
        self.maxHeight = maxHeight
        duration = asset.duration.seconds
    }

    private func start(at t: Double) {
        reader?.cancelReading()
        let r = try! AVAssetReader(asset: asset)
        r.timeRange = CMTimeRange(start: CMTime(seconds: max(0, t - 0.5), preferredTimescale: 600), end: .positiveInfinity)
        let o = AVAssetReaderTrackOutput(track: asset.tracks(withMediaType: .video).first!,
                                         outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        o.alwaysCopiesSampleData = false
        r.add(o)
        r.startReading()
        reader = r; output = o; current = nil; next = nil
    }

    private func decode() -> (time: Double, image: CGImage)? {
        guard let sample = output?.copyNextSampleBuffer(), let pixels = CMSampleBufferGetImageBuffer(sample) else { return nil }
        var image = CIImage(cvPixelBuffer: pixels)
        if let maxHeight, image.extent.height > maxHeight {
            let k = maxHeight / image.extent.height
            image = image.transformed(by: CGAffineTransform(scaleX: k, y: k))
        }
        var cg = Footage.ci.createCGImage(image, from: image.extent)!
        if let touchUp {
            let ctx = makeContext(cg.width, cg.height)
            drawImage(ctx, cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
            touchUp(ctx, cg)
            cg = ctx.makeImage()!
        }
        return (CMSampleBufferGetPresentationTimeStamp(sample).seconds, cg)
    }
    private static let ci = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB)!])

    /// The frame showing at `t`: the last one at or before it.
    func frame(_ t: Double) -> CGImage {
        let t = clamp(t, 0, duration - 0.001)
        if current == nil || t < current!.time - 0.0001 { start(at: t); current = decode() }
        while true {
            if next == nil { next = decode() }
            guard let n = next, n.time <= t else { break }
            current = n
            next = nil
        }
        return current!.image
    }
}

// MARK: Drawing helpers (a top-left origin context)

func makeContext(_ width: Int, _ height: Int, data: UnsafeMutableRawPointer? = nil, bytesPerRow: Int = 0) -> CGContext {
    let ctx = CGContext(data: data, width: width, height: height, bitsPerComponent: 8, bytesPerRow: bytesPerRow,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    ctx.translateBy(x: 0, y: CGFloat(height))
    ctx.scaleBy(x: 1, y: -1)
    ctx.interpolationQuality = .high
    return ctx
}

func drawImage(_ ctx: CGContext, _ image: CGImage, in rect: CGRect) {
    ctx.saveGState()
    ctx.translateBy(x: rect.minX, y: rect.maxY)
    ctx.scaleBy(x: 1, y: -1)
    ctx.draw(image, in: CGRect(origin: .zero, size: rect.size))
    ctx.restoreGState()
}

func roundedPath(_ rect: CGRect, _ radius: CGFloat) -> CGPath {
    CGPath(roundedRect: rect, cornerWidth: min(radius, rect.width / 2), cornerHeight: min(radius, rect.height / 2), transform: nil)
}

func font(_ size: CGFloat, _ weight: NSFont.Weight) -> NSFont {
    let base = NSFont.systemFont(ofSize: size, weight: weight)
    // SF Pro Rounded for the headline and captions, as the app's big numbers use.
    if let rounded = base.fontDescriptor.withDesign(.rounded), let font = NSFont(descriptor: rounded, size: size) { return font }
    return base
}

func attributed(_ text: String, _ font: NSFont, _ color: CGColor, kern: CGFloat = 0) -> NSAttributedString {
    NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: NSColor(cgColor: color)!, .kern: kern])
}

/// Draws text with its top-left at `point`, in a top-left context.
func drawText(_ ctx: CGContext, _ text: NSAttributedString, at point: CGPoint) {
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
    text.draw(at: point)
    NSGraphicsContext.restoreGraphicsState()
}

// MARK: Writing

/// Writes `frames` frames of `size` at 30 fps, H.264, with a silent stereo AAC track if asked.
func writeVideo(_ url: URL, size: CGSize, frames: Int, bitrate: Int, profile: String, audio: Bool,
                draw: (CGContext, Int) -> Void) {
    try? FileManager.default.removeItem(at: url)
    let writer = try! AVAssetWriter(outputURL: url, fileType: .mp4)
    let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: Int(size.width), AVVideoHeightKey: Int(size.height),
        AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: bitrate, AVVideoProfileLevelKey: profile,
                                          AVVideoExpectedSourceFrameRateKey: 30, AVVideoMaxKeyFrameIntervalKey: 30,
                                          AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC],
        AVVideoColorPropertiesKey: [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                                    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                                    AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2],
    ])
    video.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: Int(size.width), kCVPixelBufferHeightKey as String: Int(size.height),
    ])
    writer.add(video)
    writer.startWriting()
    writer.startSession(atSourceTime: .zero)
    for i in 0..<frames {
        while !video.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
        var pixels: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pixels)
        let buffer = pixels!
        CVPixelBufferLockBaseAddress(buffer, [])
        let ctx = makeContext(Int(size.width), Int(size.height), data: CVPixelBufferGetBaseAddress(buffer),
                              bytesPerRow: CVPixelBufferGetBytesPerRow(buffer))
        autoreleasepool { draw(ctx, i) }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: 30))
        if i % 60 == 0 { print("  frame \(i)/\(frames)") }
    }
    video.markAsFinished()
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    if writer.status != .completed { fatalError("writing \(url.lastPathComponent) failed: \(String(describing: writer.error))") }
    if audio { addSilentStereo(url, seconds: Double(frames) / 30) }
    print("wrote", url.path)
}

/// Apple wants an audio track on a preview: a silent stereo AAC one, written on its own and
/// then muxed in without re-encoding the video (one writer with both inputs stalled).
func addSilentStereo(_ url: URL, seconds: Double) {
    let m4a = url.deletingPathExtension().appendingPathExtension("silence.m4a")
    try? FileManager.default.removeItem(at: m4a)
    let writer = try! AVAssetWriter(outputURL: m4a, fileType: .m4a)
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 128_000,
    ])
    input.expectsMediaDataInRealTime = false
    writer.add(input)
    var asbd = AudioStreamBasicDescription(mSampleRate: 44_100, mFormatID: kAudioFormatLinearPCM,
                                           mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
                                           mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 2,
                                           mBitsPerChannel: 16, mReserved: 0)
    var format: CMAudioFormatDescription?
    CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                   magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
    writer.startWriting()
    writer.startSession(atSourceTime: .zero)
    let total = Int(seconds * 44_100) + 4_410
    var written = 0
    while written < total {
        while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
        let count = min(4_096, total - written)
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: count * 4, blockAllocator: nil,
                                           customBlockSource: nil, offsetToData: 0, dataLength: count * 4,
                                           flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
        CMBlockBufferFillDataBytes(with: 0, blockBuffer: block!, offsetIntoDestination: 0, dataLength: count * 4)
        var buffer: CMSampleBuffer?
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block!, formatDescription: format!,
                                                             sampleCount: count, presentationTimeStamp: CMTime(value: CMTimeValue(written), timescale: 44_100),
                                                             packetDescriptions: nil, sampleBufferOut: &buffer)
        input.append(buffer!)
        written += count
    }
    input.markAsFinished()
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()

    let video = AVURLAsset(url: url), sound = AVURLAsset(url: m4a)
    let mix = AVMutableComposition()
    let range = CMTimeRange(start: .zero, duration: video.duration)
    let v = mix.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
    try! v.insertTimeRange(range, of: video.tracks(withMediaType: .video)[0], at: .zero)
    let s = mix.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
    try! s.insertTimeRange(range, of: sound.tracks(withMediaType: .audio)[0], at: .zero)
    let muxed = url.deletingPathExtension().appendingPathExtension("muxed.mp4")
    try? FileManager.default.removeItem(at: muxed)
    let export = AVAssetExportSession(asset: mix, presetName: AVAssetExportPresetPassthrough)!
    export.outputURL = muxed
    export.outputFileType = .mp4
    let exported = DispatchSemaphore(value: 0)
    export.exportAsynchronously { exported.signal() }
    exported.wait()
    guard export.status == .completed else { fatalError("muxing the silent track failed: \(String(describing: export.error))") }
    try! FileManager.default.removeItem(at: url)
    try! FileManager.default.moveItem(at: muxed, to: url)
    try? FileManager.default.removeItem(at: m4a)
}

func writePNG(_ image: CGImage, _ url: URL) {
    // Opaque: App Store Connect refuses an alpha channel.
    let ctx = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    let png = NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])!
    try! png.write(to: url)
    print("wrote", url.path)
}

// MARK: The app preview (886 × 1920, 30 fps, silent stereo AAC; Apple: 15–30 s, real footage)

/// One stretch of footage: `src0`…`src1` of a recording played over `out` seconds, with a slow
/// zoom from `z0` to `z1` about `anchor` (fractions of the screen) and the caption it sits under.
struct Piece {
    let footage: Footage
    let src0: Double, src1: Double, out: Double
    var z0 = 1.0, z1 = 1.0
    var anchor = CGPoint(x: 0.5, y: 0.5)
    let caption: Int
}

let captions = ["Your numbers in one place", "Add a lab report.\nCheck each value.", "Your next health steps,\nin one list",
                "Every step shows its evidence", "Ask about your results"]

/// The footage of `piece` at `u` (0…1 through it), filling `size`.
func drawPiece(_ ctx: CGContext, _ piece: Piece, _ u: Double, size: CGSize) {
    let image = piece.footage.frame(lerp(piece.src0, piece.src1, u))
    let w = CGFloat(image.width), h = CGFloat(image.height)
    let fill = max(size.width / w, size.height / h) * lerp(piece.z0, piece.z1, easeInOut(u))
    let anchorOut = CGPoint(x: piece.anchor.x * size.width, y: piece.anchor.y * size.height)
    let rect = CGRect(x: anchorOut.x - piece.anchor.x * w * fill, y: anchorOut.y - piece.anchor.y * h * fill, width: w * fill, height: h * fill)
    drawImage(ctx, image, in: rect)
}

/// A caption: white rounded type on the accent, centred, a pill above the tab bar.
func drawCaption(_ ctx: CGContext, _ text: String, alpha: Double, rise: Double, size: CGSize) {
    guard alpha > 0.001 else { return }
    let lines = text.split(separator: "\n").map { attributed(String($0), font(54, .semibold), onAccent, kern: -0.3) }
    let lineHeight: CGFloat = 66
    let textW = lines.map { $0.size().width }.max()!
    let pill = CGSize(width: textW + 84, height: CGFloat(lines.count) * lineHeight + 46)
    let center = CGPoint(x: size.width / 2, y: size.height * 0.815 + CGFloat(rise))
    let rect = CGRect(x: center.x - pill.width / 2, y: center.y - pill.height / 2, width: pill.width, height: pill.height)
    ctx.saveGState()
    ctx.setAlpha(CGFloat(alpha))
    ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 40, color: CGColor(gray: 0, alpha: 0.28))
    ctx.addPath(roundedPath(rect, lines.count == 1 ? pill.height / 2 : 44))
    ctx.setFillColor(accent)
    ctx.fillPath()
    ctx.setShadow(offset: .zero, blur: 0, color: nil)
    for (i, line) in lines.enumerated() {
        let s = line.size()
        drawText(ctx, line, at: CGPoint(x: center.x - s.width / 2, y: rect.minY + 23 + CGFloat(i) * lineHeight + (lineHeight - s.height) / 2))
    }
    ctx.endTransparencyLayer()
    ctx.restoreGState()
}

/// The iPhone clip's status bar made to match the simulator's: the Focus symbol next to the time
/// painted out with the bar's own background, and the island drawn where an iPhone has it (a
/// screen recording leaves it out; the simulator's recordings draw it). Fractions of the
/// 1290 × 2796 recording, so they hold at any decoded size.
func chatStatusBar(_ ctx: CGContext, _ image: CGImage) {
    let w = CGFloat(image.width), h = CGFloat(image.height)
    let probe = makeContext(1, 1) // the bar's background, just right of the symbol
    drawImage(probe, image.cropping(to: CGRect(x: Int(w * 0.29), y: Int(h * 0.032), width: 1, height: 1))!, in: CGRect(x: 0, y: 0, width: 1, height: 1))
    let px = probe.data!.assumingMemoryBound(to: UInt8.self)
    ctx.setFillColor(CGColor(srgbRed: CGFloat(px[2]) / 255, green: CGFloat(px[1]) / 255, blue: CGFloat(px[0]) / 255, alpha: 1))
    ctx.fill(CGRect(x: w * 0.212, y: h * 0.019, width: w * 0.048, height: h * 0.027))
    ctx.addPath(roundedPath(CGRect(x: w * 0.3547, y: h * 0.0118, width: w * 0.2907, height: h * 0.0397), h * 0.02))
    ctx.setFillColor(CGColor(gray: 0, alpha: 1))
    ctx.fillPath()
}

/// The clip's beats, from how much the picture changes below the status bar: `start` just
/// before the tap on a starter question, `sent` once the sources show and the app is writing,
/// `answer` just before the answer lands. The still wait between `sent` and `answer` is cut.
func chatTimes(_ clip: Footage) -> (start: Double, sent: Double, answer: Double) {
    let reader = try! AVAssetReader(asset: clip.asset)
    let output = AVAssetReaderTrackOutput(track: clip.asset.tracks(withMediaType: .video)[0],
                                          outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    reader.add(output)
    reader.startReading()
    var previous: [UInt8]?
    var changes: [(Double, Double)] = []
    while let sample = output.copyNextSampleBuffer() {
        guard let pixels = CMSampleBufferGetImageBuffer(sample) else { continue }
        CVPixelBufferLockBaseAddress(pixels, .readOnly)
        let w = CVPixelBufferGetWidth(pixels), h = CVPixelBufferGetHeight(pixels), row = CVPixelBufferGetBytesPerRow(pixels)
        let base = CVPixelBufferGetBaseAddress(pixels)!.assumingMemoryBound(to: UInt8.self)
        var grid: [UInt8] = []
        for y in stride(from: h * 6 / 100, to: h, by: h / 160) { for x in stride(from: 0, to: w, by: w / 80) { grid.append(base[y * row + x * 4 + 1]) } }
        CVPixelBufferUnlockBaseAddress(pixels, .readOnly)
        if let p = previous, p.count == grid.count {
            changes.append((CMSampleBufferGetPresentationTimeStamp(sample).seconds, Double(zip(p, grid).map { abs(Int($0) - Int($1)) }.reduce(0, +)) / Double(grid.count)))
        }
        previous = grid
    }
    // Big changes only (Chat opening, the tap, the sources, the answer); a typing dot is small.
    var beats: [Double] = []
    for (t, change) in changes where change > 1.0 && (beats.last.map { t - $0 > 0.6 } ?? true) { beats.append(t) }
    guard beats.count >= 4 else { fatalError("the chat clip's beats were not found: \(beats)") }
    var wait = 1 // the longest still stretch between beats: the wait for the answer
    for n in 1..<beats.count where beats[n] - beats[n - 1] > beats[wait] - beats[wait - 1] { wait = n }
    print("chat clip beats:", beats.map { String(format: "%.2f", $0) }.joined(separator: " "),
          String(format: "; the wait %.2f to %.2f s is cut", beats[wait - 1], beats[wait]))
    return (start: beats[0] + 0.35, sent: beats[wait - 1] + 0.45, answer: beats[wait] - 0.1)
}

func makePreview(raw: URL, out: URL, chat: URL?) {
    let size = CGSize(width: 886, height: 1920)
    let rec = Footage(raw, maxHeight: 1926 * 1.15)
    var pieces = [
        // My data, as the person left it; a slow push towards the numbers.
        Piece(footage: rec, src0: mark("mydata") + 0.2, src1: mark("mydata") + 5.4, out: 4.6, z0: 1.0, z1: 1.06, anchor: CGPoint(x: 0.5, y: 0.35), caption: 0),
        // "Add medical records": the sheet opens on where the records are.
        Piece(footage: rec, src0: mark("add") + 0.1, src1: mark("add") + 2.6, out: 2.5, caption: 1),
        // The report on its way to Claude (the photo picker and the one-time consent are left out).
        Piece(footage: rec, src0: mark("reading") + 0.3, src1: mark("reading") + 2.3, out: 2.0, caption: 1),
        // The values to check, then saved, then on My data.
        Piece(footage: rec, src0: mark("review") + 0.4, src1: mark("save") + 0.1, out: 4.4, z0: 1.0, z1: 1.1, anchor: CGPoint(x: 0.5, y: 0.42), caption: 1),
        Piece(footage: rec, src0: mark("save") + 0.1, src1: mark("saved") + 1.0, out: 1.8, caption: 1),
        Piece(footage: rec, src0: mark("after") - 0.3, src1: mark("after") + 3.6, out: 3.0, caption: 1),
        // My plan, then one step opened to its evidence.
        Piece(footage: rec, src0: mark("plan") + 0.3, src1: mark("plan") + 6.2, out: 4.4, caption: 2),
        Piece(footage: rec, src0: mark("open") - 0.1, src1: mark("evidence") + 3.2, out: 5.5, z0: 1.0, z1: 1.04, anchor: CGPoint(x: 0.5, y: 0.4), caption: 3),
    ]
    if let chat {
        // Chat, filmed on an iPhone (the simulator cannot answer): the tap on a starter question,
        // then, past the wait for the answer, the answer arriving and held.
        let clip = Footage(chat, maxHeight: 1926 * 1.15)
        clip.touchUp = { ctx, image in chatStatusBar(ctx, image) }
        let times = chatTimes(clip)
        pieces.append(Piece(footage: clip, src0: times.start, src1: times.sent, out: (times.sent - times.start) / 1.25, caption: 4))
        pieces.append(Piece(footage: clip, src0: times.answer, src1: min(clip.duration, times.answer + 3.3), out: 3.3, caption: 4))
        // Apple's ceiling is 30 s: the app's own beats give up the time, evenly.
        let fixed = pieces.suffix(2).map(\.out).reduce(0, +)
        let flexible = pieces.dropLast(2).map(\.out).reduce(0, +)
        let scale = (29.0 + 0.45 * Double(pieces.count - 1) - fixed) / flexible
        if scale < 1 {
            pieces = pieces.enumerated().map { n, p in
                n >= pieces.count - 2 ? p : Piece(footage: p.footage, src0: p.src0, src1: p.src1, out: p.out * scale, z0: p.z0, z1: p.z1, anchor: p.anchor, caption: p.caption)
            }
        }
    }
    let fade = 0.45
    var starts: [Double] = []
    var t = 0.0
    for piece in pieces { starts.append(t); t += piece.out - fade }
    let total = t + fade
    let frames = Int((total * 30).rounded())
    print(String(format: "preview: %.2f s, %d frames, %d pieces", total, frames, pieces.count))
    if total > 30 { fatalError("the preview runs past Apple's 30 s; shorten a piece") }

    // A caption shows from its first piece's start to the next caption's first piece.
    var captionSpans: [(Int, Double, Double)] = []
    for (i, piece) in pieces.enumerated() where i == 0 || pieces[i - 1].caption != piece.caption {
        if !captionSpans.isEmpty { captionSpans[captionSpans.count - 1].2 = starts[i] + fade / 2 }
        captionSpans.append((piece.caption, i == 0 ? -1 : starts[i] + fade / 2, total - fade))
    }
    let loopFade = fade

    writeVideo(out, size: size, frames: frames, bitrate: 10_000_000, profile: AVVideoProfileLevelH264High40, audio: true) { ctx, i in
        let t = Double(i) / 30
        ctx.setFillColor(launchBackground)
        ctx.fill(CGRect(origin: .zero, size: size))
        for (k, piece) in pieces.enumerated() {
            let u = (t - starts[k]) / piece.out
            guard u >= 0, u <= 1 else { continue }
            let fadeIn = k == 0 ? 1 : clamp((t - starts[k]) / fade)
            ctx.saveGState()
            ctx.setAlpha(CGFloat(easeInOut(fadeIn)))
            drawPiece(ctx, piece, u, size: size)
            ctx.restoreGState()
        }
        // The loop: the last moments dissolve into the first frame.
        let back = clamp((t - (total - loopFade)) / loopFade)
        if back > 0 {
            ctx.saveGState()
            ctx.setAlpha(CGFloat(easeInOut(back)))
            drawPiece(ctx, pieces[0], 0, size: size)
            ctx.restoreGState()
        }
        for (caption, from, to) in captionSpans {
            let appear = from < 0 ? 1 : spring(phase(t, from, 0.6))
            let leave = to >= total - fade ? 1 - clamp(back * 2) : 1 - phase(t, to - 0.3, 0.3)
            let alpha = min(from < 0 ? 1 : phase(t, from, 0.25), leave)
            drawCaption(ctx, captions[caption], alpha: alpha, rise: (1 - appear) * 40, size: size)
        }
        // Caption 0 comes back with the loop.
        if back > 0.5 { drawCaption(ctx, captions[pieces[0].caption], alpha: easeInOut(back * 2 - 1), rise: 0, size: size) } // after the last one has gone
    }
}

// MARK: The header video (3840 × 1646, 21:9, 15 s, 30 fps, loops; Apple crops it per device)

/// A phone outline drawn here (no Apple artwork): a dark rounded body, the screen inside it,
/// an island. `screen` is the screen's rect; `content` draws into it, clipped.
func drawPhone(_ ctx: CGContext, screen: CGRect, rotation: Double = 0, alpha: Double = 1, shadow: CGFloat = 1,
               content: (CGContext, CGRect) -> Void) {
    guard alpha > 0.001 else { return }
    let w = screen.width
    let bezel = w * 0.032
    let body = screen.insetBy(dx: -bezel, dy: -bezel)
    let radius = w * 0.135
    ctx.saveGState()
    ctx.translateBy(x: screen.midX, y: screen.midY)
    ctx.rotate(by: CGFloat(rotation * .pi / 180))
    ctx.translateBy(x: -screen.midX, y: -screen.midY)
    ctx.setAlpha(CGFloat(alpha))
    ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    // Two soft shadows: a wide ambient one and a tighter contact one.
    ctx.setShadow(offset: CGSize(width: 0, height: -w * 0.07 * shadow), blur: w * 0.22 * shadow, color: CGColor(srgbRed: 0, green: 0.08, blue: 0.05, alpha: 0.45))
    ctx.addPath(roundedPath(body, radius + bezel))
    ctx.setFillColor(CGColor(srgbRed: 0.07, green: 0.08, blue: 0.08, alpha: 1))
    ctx.fillPath()
    ctx.setShadow(offset: CGSize(width: 0, height: -w * 0.012), blur: w * 0.03, color: CGColor(gray: 0, alpha: 0.35))
    ctx.addPath(roundedPath(body, radius + bezel))
    ctx.fillPath()
    ctx.setShadow(offset: .zero, blur: 0, color: nil)
    // A thin lighter rim, so the edge reads on the dark green.
    ctx.addPath(roundedPath(body.insetBy(dx: bezel * 0.18, dy: bezel * 0.18), radius + bezel * 0.82))
    ctx.setStrokeColor(CGColor(gray: 1, alpha: 0.16))
    ctx.setLineWidth(max(1.5, bezel * 0.12))
    ctx.strokePath()
    ctx.saveGState()
    ctx.addPath(roundedPath(screen, radius))
    ctx.clip()
    ctx.setFillColor(launchBackground)
    ctx.fill(screen)
    content(ctx, screen)
    ctx.restoreGState()
    ctx.endTransparencyLayer()
    ctx.restoreGState()
}

/// The horizontal bands of a screen (cards and rows of tiles) between rows of plain background,
/// below `top`: what the plan's cards cascade in as.
func bands(_ image: CGImage, from top: Int) -> [ClosedRange<Int>] {
    let w = image.width, h = image.height
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    let data = ctx.data!.assumingMemoryBound(to: UInt8.self)
    let bg = data[(h - 1 - top) * w * 4 + 8 * 4] // the background, at the left edge just below `top`
    func plain(_ y: Int) -> Bool { // top-left y
        let row = (h - 1 - y) * w * 4
        return stride(from: w / 40, to: w - w / 40, by: w / 60).allSatisfy { abs(Int(data[row + $0 * 4]) - Int(bg)) < 4 }
    }
    var out: [ClosedRange<Int>] = []
    var start: Int?
    for y in top..<h {
        if plain(y) { if let s = start, y - s > 20 { out.append(s...(y - 1)) }; start = nil }
        else if start == nil { start = y }
    }
    if let s = start, h - s > 20 { out.append(s...(h - 1)) }
    return out
}

struct HeaderLayout {
    let size: CGSize
    var screenH: CGFloat { size.height * 0.79 }
    var screenW: CGFloat { screenH * 1206 / 2622 }
    var fontSize: CGFloat { size.height * 0.082 }
    var lineHeight: CGFloat { fontSize * 1.2 }
    var textTop: CGFloat { size.height * 0.052 }
    var phonesTop: CGFloat { size.height * 0.29 }
    var sideOffset: CGFloat { screenW * 1.38 }
    let sideScale: CGFloat = 0.9
    func center(_ slot: Int) -> CGRect { // 0 left, 1 centre, 2 right
        let s = slot == 1 ? 1 : sideScale
        let w = screenW * s, h = screenH * s
        let x = size.width / 2 + CGFloat(slot - 1) * sideOffset - w / 2
        return CGRect(x: x, y: phonesTop + (slot == 1 ? 0 : screenH * 0.07), width: w, height: h)
    }
}

let headline = [["Your", "blood", "tests,"], ["turned", "into", "next", "steps."]]

/// The headline, word by word: each word rises into view through its own mask (`reveal` 0 → 1
/// per word), or rises out of it (`leave`).
func drawHeadline(_ ctx: CGContext, _ layout: HeaderLayout, word: (Int) -> (reveal: Double, leave: Double)) {
    let f = font(layout.fontSize, .bold)
    let space = attributed(" ", f, onAccent).size().width
    var index = 0
    for (n, line) in headline.enumerated() {
        let words = line.map { attributed($0, f, onAccent, kern: -layout.fontSize * 0.01) }
        let width = words.map { $0.size().width }.reduce(0, +) + space * CGFloat(words.count - 1)
        var x = layout.size.width / 2 - width / 2
        let y = layout.textTop + CGFloat(n) * layout.lineHeight
        for w in words {
            let s = w.size()
            let (reveal, leave) = word(index)
            index += 1
            defer { x += s.width + space }
            guard reveal > 0, leave < 1 else { continue }
            let mask = CGRect(x: x - 10, y: y - layout.fontSize * 0.1, width: s.width + 20, height: s.height + layout.fontSize * 0.25)
            ctx.saveGState()
            ctx.clip(to: mask)
            let dy = (1 - reveal) * Double(mask.height) - leave * Double(mask.height)
            ctx.setShadow(offset: CGSize(width: 0, height: -layout.fontSize * 0.04), blur: layout.fontSize * 0.25, color: CGColor(srgbRed: 0, green: 0.12, blue: 0.08, alpha: 0.35))
            drawText(ctx, w, at: CGPoint(x: x, y: y + CGFloat(dy)))
            ctx.restoreGState()
        }
    }
}

/// The brand background: the accent, deeper at the bottom, with a soft light drifting once a loop.
func drawBackground(_ ctx: CGContext, _ size: CGSize, loop: Double, parallax: CGPoint = .zero) {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let linear = CGGradient(colorsSpace: space, colors: [accent, accentDeep] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(linear, start: .zero, end: CGPoint(x: 0, y: size.height), options: [])
    let angle = loop * 2 * .pi
    let glow = CGPoint(x: size.width * (0.5 + 0.12 * sin(angle)) + parallax.x, y: size.height * (0.2 + 0.06 * cos(angle)) + parallax.y)
    let light = CGGradient(colorsSpace: space, colors: [accentLight.copy(alpha: 0.42)!, accentLight.copy(alpha: 0)!] as CFArray, locations: [0, 1])!
    ctx.drawRadialGradient(light, startCenter: glow, startRadius: 0, endCenter: glow, endRadius: size.height * 1.05, options: [])
    // A vignette keeps the eye in the middle, where every device's crop keeps it.
    let edge = CGGradient(colorsSpace: space, colors: [CGColor(gray: 0, alpha: 0), CGColor(gray: 0, alpha: 0.28)] as CFArray, locations: [0.55, 1])!
    let mid = CGPoint(x: size.width / 2, y: size.height * 0.45)
    ctx.drawRadialGradient(edge, startCenter: mid, startRadius: 0, endCenter: mid, endRadius: size.width * 0.62, options: [.drawsAfterEndLocation])
}

/// Fills `rect` with `image` (aspect fill, top aligned).
func fillScreen(_ ctx: CGContext, _ image: CGImage, _ rect: CGRect) {
    let k = max(rect.width / CGFloat(image.width), rect.height / CGFloat(image.height))
    drawImage(ctx, image, in: CGRect(x: rect.midX - CGFloat(image.width) * k / 2, y: rect.minY, width: CGFloat(image.width) * k, height: CGFloat(image.height) * k))
}

/// The resting picture: headline, then the report read (left), My data (centre), the plan (right).
func drawTableau(_ ctx: CGContext, _ layout: HeaderLayout, loop: Double, screens: [CGImage], offsets: [CGFloat] = [0, 0, 0],
                 alphas: [Double] = [1, 1, 1], skip: Set<Int> = [], headlineWord: ((Int) -> (Double, Double))? = nil) {
    drawBackground(ctx, layout.size, loop: loop)
    drawHeadline(ctx, layout, word: headlineWord ?? { _ in (1, 0) })
    for slot in [0, 2, 1] where !skip.contains(slot) {
        var r = layout.center(slot)
        r.origin.x += offsets[slot]
        r.origin.y += CGFloat(sin(loop * 2 * .pi * 3 + Double(slot) * 2.1)) * layout.size.height * 0.004
        drawPhone(ctx, screen: r, rotation: Double(slot - 1) * 2.0, alpha: alphas[slot]) { c, rect in fillScreen(c, screens[slot], rect) }
    }
}

func makeHeader(raw: URL, outDir: URL) {
    let size = CGSize(width: 3840, height: 1646)
    let layout = HeaderLayout(size: size)
    let T = 15.0
    let frames = Int(T * 30)
    // Separate readers for footage that plays at the same moment.
    let rec = Footage(raw)
    let still = Footage(raw)
    let report = NSImage(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]).deletingLastPathComponent().appendingPathComponent("report.png"))!
        .cgImage(forProposedRect: nil, context: nil, hints: nil)!

    // The three resting screens, and the frames the story ends on.
    let reviewStill = still.frame(mark("review") + 1.2)
    let myDataStill = still.frame(mark("after") + 3.6)
    let planStill = still.frame(mark("plan") + 5.8)
    let planFirst = still.frame(mark("plan") + 0.4)
    let planBands = bands(planFirst, from: Int(Double(planFirst.height) * 0.105))
    let screens = [reviewStill, myDataStill, planStill]
    let words = headline.flatMap { $0 }.count

    // Beats, in seconds.
    let exitAt = 1.0, readAt = 1.9, absorbAt = 2.6, valuesAt = 3.4, pullAt = 5.0, myDataAt = 5.9, planAt = 8.15, cascadeAt = 8.12,
        planCloseAt = 10.4, returnAt = 12.0, restAt = 13.5

    let paperH = layout.screenH * 0.98
    let paperW = paperH * CGFloat(report.width) / CGFloat(report.height)
    let heroRest = layout.center(1)
    let heroStage = heroRest.offsetBy(dx: layout.screenW * 0.72, dy: -layout.size.height * 0.06)
    let paperStage = CGRect(x: size.width / 2 - layout.screenW * 0.72 - paperW / 2, y: heroStage.minY + layout.screenH * 0.02, width: paperW, height: paperH)
    // The report's rows (report pixels, top-left): where each value is printed.
    let rows: [CGRect] = [446, 506, 566, 626, 756].map { CGRect(x: 80, y: $0, width: 1080, height: 56) }

    writeVideo(outDir.appendingPathComponent("header-3840x1646.mp4"), size: size, frames: frames, bitrate: 45_000_000,
               profile: AVVideoProfileLevelH264HighAutoLevel, audio: false) { ctx, i in
        let t = Double(i) / 30
        let loop = t / T

        // Camera: a push-in for each close-up, back out between them.
        let screenAt = { (r: CGRect, fx: Double, fy: Double) in CGPoint(x: r.minX + r.width * fx, y: r.minY + r.height * fy) }
        var hero = heroRest
        var heroRotation = 0.0
        if t >= exitAt {
            let go = spring(phase(t, exitAt, 1.0))
            hero = CGRect(x: lerp(heroRest.minX, heroStage.minX, go), y: lerp(heroRest.minY, heroStage.minY, go), width: heroRest.width, height: heroRest.height)
        }
        if t >= pullAt {
            let back = easeInOut(phase(t, pullAt, 0.8))
            hero = CGRect(x: lerp(heroStage.minX, heroRest.minX, back), y: lerp(heroStage.minY, heroRest.minY - layout.size.height * 0.04, back), width: heroRest.width, height: heroRest.height)
        }
        if t >= returnAt {
            let r = layout.center(2)
            let go = spring(phase(t, returnAt, 1.1))
            let from = heroRest.offsetBy(dx: 0, dy: -layout.size.height * 0.04)
            hero = CGRect(x: lerp(from.minX, r.minX, go), y: lerp(from.minY, r.minY, go), width: lerp(from.width, r.width, go), height: lerp(from.height, r.height, go))
            heroRotation = 2.0 * go
        }
        // The camera, by keyframes (time, zoom, what sits at the centre), eased between them. A
        // point given as fractions of the hero phone follows the phone as it moves.
        enum Aim { case canvas(CGPoint), hero(Double, Double) }
        let centre = CGPoint(x: size.width / 2, y: size.height / 2)
        let gap = -Double(layout.screenW * 0.72 / hero.width) + 0.5 // between the paper and the phone
        let keys: [(Double, Double, Aim)] = [
            (0, 1, .canvas(centre)), (exitAt + 0.3, 1, .canvas(centre)), (readAt + 0.1, 1.2, .hero(gap, 0.43)), (valuesAt, 1.2, .hero(gap, 0.43)),
            (valuesAt + 0.75, 2.15, .hero(0.5, 0.5)), (pullAt, 2.15, .hero(0.5, 0.5)),
            (myDataAt, 1.1, .hero(0.5, 0.5)), (myDataAt + 0.6, 1.1, .hero(0.5, 0.5)),
            (myDataAt + 1.3, 1.9, .hero(0.5, 0.62)), (planAt - 0.5, 1.9, .hero(0.5, 0.62)),
            (planAt + 0.2, 1.1, .hero(0.5, 0.5)), (planCloseAt, 1.1, .hero(0.5, 0.5)),
            (planCloseAt + 0.7, 2.0, .hero(0.5, 0.78)), (returnAt - 0.1, 2.0, .hero(0.5, 0.78)),
            (returnAt + 0.8, 1, .canvas(centre)), (T, 1, .canvas(centre)),
        ]
        func resolve(_ aim: Aim) -> CGPoint {
            switch aim {
            case .canvas(let p): return p
            case .hero(let fx, let fy): return screenAt(hero, fx, fy)
            }
        }
        var zoom = 1.0
        var focus = centre
        for n in 1..<keys.count where t >= keys[n - 1].0 && t <= keys[n].0 {
            let (t0, z0, a0) = keys[n - 1], (t1, z1, a1) = keys[n]
            let e = easeInOut(phase(t, t0, t1 - t0))
            zoom = exp(lerp(log(z0), log(z1), e)) // an even-feeling zoom speed
            focus = lerp(resolve(a0), resolve(a1), e)
        }

        drawBackground(ctx, size, loop: loop, parallax: CGPoint(x: -(focus.x - size.width / 2) * 0.08, y: -(focus.y - size.height / 2) * 0.08))

        // The headline: out word by word on the first beat, back in at the end.
        drawHeadline(ctx, layout) { k in
            let stagger = Double(k) * 0.05
            let leave = easeInOut(phase(t, exitAt + stagger, 0.45))
            let reveal = t < returnAt ? 1 : spring(phase(t, returnAt + 0.55 + stagger, 0.6))
            return t < returnAt ? (1, leave) : (reveal, 0)
        }

        ctx.saveGState()
        ctx.translateBy(x: size.width / 2, y: size.height / 2)
        ctx.scaleBy(x: CGFloat(zoom), y: CGFloat(zoom))
        ctx.translateBy(x: -focus.x, y: -focus.y)

        // The side phones: out on the first beat, back in (from the left) at the end.
        let bob = { (slot: Int) in CGFloat(sin(loop * 2 * .pi * 3 + Double(slot) * 2.1)) * layout.size.height * 0.004 }
        if t < returnAt {
            let out = phase(t, exitAt, 0.6)
            let ease = easeInOut(out)
            for slot in [0, 2] where ease < 1 {
                let r = layout.center(slot).offsetBy(dx: CGFloat(slot - 1) * size.width * 0.45 * CGFloat(ease), dy: bob(slot))
                drawPhone(ctx, screen: r, rotation: Double(slot - 1) * 2.0, alpha: 1 - ease * 0.3) { c, rect in fillScreen(c, screens[slot], rect) }
            }
        } else {
            for (n, slot) in [0, 1].enumerated() {
                let come = spring(phase(t, returnAt + 0.15 + Double(n) * 0.16, 1.0))
                let r = layout.center(slot).offsetBy(dx: -size.width * 0.6 * CGFloat(1 - come), dy: bob(slot))
                drawPhone(ctx, screen: r, rotation: Double(slot - 1) * 2.0) { c, rect in fillScreen(c, screens[slot], rect) }
            }
        }

        // The hero phone and what it shows.
        let heroBob = t < exitAt ? bob(1) * CGFloat(1 - phase(t, exitAt - 0.3, 0.3)) : bob(2) * CGFloat(phase(t, restAt - 0.5, 0.5))
        drawPhone(ctx, screen: hero.offsetBy(dx: 0, dy: heroBob), rotation: heroRotation) { c, rect in
            func play(_ footage: Footage, _ start: Double, _ end: Double, _ from: Double, _ to: Double) -> CGImage {
                footage.frame(lerp(from, to, phase(t, start, end - start)))
            }
            if t < exitAt + 0.45 {
                fillScreen(c, myDataStill, rect)
            } else if t < valuesAt {
                // The report being read: the sheet's reading picture, then the values.
                if t < exitAt + 0.75 { fillScreen(c, myDataStill, rect) }
                c.saveGState()
                c.setAlpha(CGFloat(easeInOut(phase(t, exitAt + 0.45, 0.3))))
                fillScreen(c, play(rec, readAt - 0.6, valuesAt, mark("reading") + 0.1, mark("review") + 0.3), rect)
                c.restoreGState()
            } else if t < myDataAt {
                fillScreen(c, play(rec, valuesAt, myDataAt, mark("review") + 0.3, mark("saved") + 0.6), rect)
            } else if t < planAt {
                let mine = play(rec, myDataAt, planAt + 0.5, mark("after") - 0.1, mark("after") + 3.6)
                if t < myDataAt + 0.3 { fillScreen(c, still.frame(mark("saved") + 0.6), rect) }
                c.saveGState()
                c.setAlpha(CGFloat(easeInOut(phase(t, myDataAt, 0.3))))
                fillScreen(c, mine, rect)
                c.restoreGState()
            } else if t < cascadeAt + 1.0 {
                // A push, like a tab change, then the plan's cards fall into place one by one.
                let push = spring(phase(t, planAt, 0.55))
                c.saveGState()
                c.translateBy(x: -rect.width * CGFloat(push), y: 0)
                fillScreen(c, myDataStill, rect)
                c.restoreGState()
                c.saveGState()
                c.translateBy(x: rect.width * CGFloat(1 - push), y: 0)
                let k = rect.width / CGFloat(planFirst.width)
                let topCut = CGFloat(planBands.first?.lowerBound ?? 0)
                c.saveGState()
                c.clip(to: CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: topCut * k))
                fillScreen(c, planFirst, rect)
                c.restoreGState()
                for (n, band) in planBands.enumerated() {
                    let p = spring(phase(t, cascadeAt + Double(n) * 0.08, 0.6))
                    guard p > 0 else { continue }
                    let crop = planFirst.cropping(to: CGRect(x: 0, y: band.lowerBound, width: planFirst.width, height: band.count))!
                    let dest = CGRect(x: rect.minX, y: rect.minY + CGFloat(band.lowerBound) * k, width: rect.width, height: CGFloat(band.count) * k)
                    c.saveGState()
                    c.setAlpha(CGFloat(min(1, p * 1.6)))
                    drawImage(c, crop, in: dest.offsetBy(dx: 0, dy: CGFloat(1 - p) * rect.height * 0.12))
                    c.restoreGState()
                }
                c.restoreGState()
            } else {
                fillScreen(c, play(rec, cascadeAt + 1.0, returnAt, mark("plan") + 0.4, mark("plan") + 5.8), rect)
            }
        }

        // The paper report: slides in, a light reads down it, its values lift off into the phone.
        if t >= exitAt && t < valuesAt + 0.2 {
            let come = spring(phase(t, exitAt + 0.35, 0.9))
            var paper = paperStage.offsetBy(dx: -size.width * 0.5 * CGFloat(1 - come), dy: 0)
            let rotation = lerp(-12, -3.5, come)
            // Its values gone, the paper slides away to the left, under the light.
            let gone = phase(t, absorbAt + 0.3, 0.55)
            let away = gone * gone * gone
            paper = paper.offsetBy(dx: -CGFloat(away) * size.width * 0.55, dy: CGFloat(away) * paperH * 0.08)
            ctx.saveGState()
            ctx.translateBy(x: paper.midX, y: paper.midY)
            ctx.rotate(by: CGFloat(rotation * .pi / 180))
            ctx.translateBy(x: -paper.midX, y: -paper.midY)
            ctx.beginTransparencyLayer(auxiliaryInfo: nil)
            ctx.setShadow(offset: CGSize(width: 0, height: -paperW * 0.04), blur: paperW * 0.12, color: CGColor(srgbRed: 0, green: 0.08, blue: 0.05, alpha: 0.45))
            ctx.setFillColor(CGColor(gray: 1, alpha: 1))
            ctx.fill(paper)
            ctx.setShadow(offset: .zero, blur: 0, color: nil)
            drawImage(ctx, report, in: paper)
            // The reading light.
            let scan = phase(t, readAt, 0.9)
            if scan > 0 && scan < 1 {
                let y = paper.minY + paper.height * CGFloat(lerp(0.2, 0.55, easeInOut(scan)))
                let band = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      colors: [accentLight.copy(alpha: 0)!, accentLight.copy(alpha: 0.45)!, accentLight.copy(alpha: 0)!] as CFArray, locations: [0, 0.5, 1])!
                ctx.saveGState()
                ctx.clip(to: paper)
                ctx.drawLinearGradient(band, start: CGPoint(x: 0, y: y - paperH * 0.06), end: CGPoint(x: 0, y: y + paperH * 0.06), options: [])
                ctx.restoreGState()
            }
            ctx.endTransparencyLayer()
            ctx.restoreGState()
        }
        // Each printed value lifts off the paper and lands in the phone's list.
        let k = paperW / CGFloat(report.width)
        for (n, row) in rows.enumerated() {
            let fly = phase(t, absorbAt + Double(n) * 0.07, 0.62)
            guard fly > 0, fly < 1 else { continue }
            let e = easeInOut(fly)
            let from = CGRect(x: paperStage.minX + row.minX * k, y: paperStage.minY + row.minY * k, width: row.width * k, height: row.height * k)
            let to = CGRect(x: heroStage.minX + heroStage.width * 0.05, y: heroStage.minY + heroStage.height * (0.455 + 0.083 * CGFloat(n)),
                            width: heroStage.width * 0.9, height: heroStage.width * 0.9 * row.height / row.width)
            let r = CGRect(x: lerp(from.minX, to.minX, e), y: lerp(from.minY, to.minY, e) - CGFloat(sin(e * .pi)) * size.height * 0.08,
                           width: lerp(from.width, to.width, e), height: lerp(from.height, to.height, e))
            ctx.saveGState()
            ctx.setAlpha(CGFloat(fly < 0.8 ? 1 : 1 - (fly - 0.8) / 0.2))
            ctx.setShadow(offset: CGSize(width: 0, height: -r.height * 0.25), blur: r.height * 0.8, color: CGColor(gray: 0, alpha: 0.35))
            ctx.addPath(roundedPath(r.insetBy(dx: -r.height * 0.2, dy: -r.height * 0.15), r.height * 0.3))
            ctx.setFillColor(CGColor(gray: 1, alpha: 1))
            ctx.fillPath()
            ctx.setShadow(offset: .zero, blur: 0, color: nil)
            drawImage(ctx, report.cropping(to: row)!, in: r)
            ctx.restoreGState()
        }
        ctx.restoreGState()
    }

    // The stills: the resting picture, at the header's size and at 3:2 for search results.
    for (name, canvas) in [("header-still-3840x1646.png", size), ("search-3x2-1920x1280.png", CGSize(width: 1920, height: 1280))] {
        let ctx = makeContext(Int(canvas.width), Int(canvas.height))
        var l = HeaderLayout(size: canvas)
        if canvas.width / canvas.height < 2 { l = HeaderLayout(size: canvas) }
        drawTableau(ctx, l, loop: 0, screens: screens)
        writePNG(ctx.makeImage()!, outDir.appendingPathComponent(name))
    }
}

// MARK: Main (last: the globals above are set up first)

setvbuf(stdout, nil, _IOLBF, 0)
let args = CommandLine.arguments
guard args.count >= 5 else { fatalError("usage: compose preview|header <raw.mp4> <marks.txt> <out> [chat clip]") }
let marks = readMarks(args[3])
func mark(_ name: String) -> Double {
    guard let t = marks[name] else { fatalError("no VIDEO-MARK \(name)") }
    return t
}
switch args[1] {
case "preview": makePreview(raw: URL(fileURLWithPath: args[2]), out: URL(fileURLWithPath: args[4]),
                            chat: args.count > 5 ? URL(fileURLWithPath: args[5]) : nil)
case "header": makeHeader(raw: URL(fileURLWithPath: args[2]), outDir: URL(fileURLWithPath: args[4]))
default: fatalError("preview or header")
}
