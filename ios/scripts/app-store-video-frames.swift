// Checks a video: prints its duration, size, frame rate, codecs and audio, and lays frames at the
// given times out as a contact sheet, each labelled with its time (ios/scripts/app-store-video.sh).
//   swift ios/scripts/app-store-video-frames.swift <video> <sheet.png> <columns> <cell width> <t1,t2,...>
// With a single time the sheet is that one frame at full size.
import AppKit
import AVFoundation

let a = CommandLine.arguments
guard a.count >= 6 else { fatalError("usage: frames <video> <sheet.png> <columns> <cell width> <t1,t2,...>") }
let asset = AVURLAsset(url: URL(fileURLWithPath: a[1]))
let track = asset.tracks(withMediaType: .video).first!
func fourCC(_ d: CMFormatDescription) -> String {
    let c = CMFormatDescriptionGetMediaSubType(d)
    return String([24, 16, 8, 0].map { Character(UnicodeScalar(UInt8((c >> $0) & 0xFF))) })
}
let videoCodec = (track.formatDescriptions as! [CMFormatDescription]).map(fourCC).joined(separator: ",")
var line = String(format: "duration %.3f s, %d × %d, %.2f fps (nominal), video %@, %.1f Mbps", asset.duration.seconds,
                  Int(track.naturalSize.width), Int(track.naturalSize.height), track.nominalFrameRate, videoCodec,
                  track.estimatedDataRate / 1_000_000)
for audio in asset.tracks(withMediaType: .audio) {
    for d in audio.formatDescriptions as! [CMFormatDescription] {
        let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(d)!.pointee
        line += String(format: ", audio %@ %d ch %.0f Hz", fourCC(d), asbd.mChannelsPerFrame, asbd.mSampleRate)
    }
}
if asset.tracks(withMediaType: .audio).isEmpty { line += ", no audio" }
print(line)

let times = a[5].split(separator: ",").map { Double($0)! }
let columns = Int(a[3])!, cellW = CGFloat(Double(a[4])!)
let gen = AVAssetImageGenerator(asset: asset)
gen.requestedTimeToleranceBefore = .zero
gen.requestedTimeToleranceAfter = .zero
let aspect = track.naturalSize.height / track.naturalSize.width
let cellH = (cellW * aspect).rounded(), label: CGFloat = times.count == 1 ? 0 : 40
let rows = (times.count + columns - 1) / columns
let W = Int(cellW) * min(columns, times.count), H = Int(cellH + label) * rows
let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
ctx.setFillColor(gray: 0.15, alpha: 1)
ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
for (i, t) in times.enumerated() {
    let x = CGFloat(i % columns) * cellW, top = CGFloat(H) - CGFloat(i / columns) * (cellH + label)
    if let image = try? gen.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil) {
        ctx.draw(image, in: CGRect(x: x + 2, y: top - label - cellH + 2, width: cellW - 4, height: cellH - 4))
    }
    if label > 0 {
        NSAttributedString(string: String(format: "%.2f s", t), attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 24, weight: .medium),
                                                                             .foregroundColor: NSColor.white]).draw(at: NSPoint(x: x + 10, y: top - 34))
    }
}
let png = NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: a[2]))
