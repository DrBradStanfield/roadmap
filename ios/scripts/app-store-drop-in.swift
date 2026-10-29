// Turns a capture from a real iPhone into a drop-in for app-store-compose.swift (Chat's slot:
// the simulator cannot reach the chat server). Takes a screenshot, or a frame of a screen
// recording at a given second; scales it to fill 1206 × 2622 (the 6.3-inch slot) and crops
// the overflow evenly; then swaps its status bar (a back link, Focus, the real time) for the
// simulator's clean 9:41 one, taken from one of app-store-shots.sh's light captures and
// redrawn in white or black to suit the capture's own background (dark mode or light).
//   swift ios/scripts/app-store-drop-in.swift <capture.mov|.png> <seconds> "ios/build/app-store-shots/4 my data.png" \
//     ios/build/app-store-assets/screenshots/drop-in/5.png
import AVFoundation
import AppKit

let width = 1206, height = 2622
/// The status bar's band on the 6.3-inch screen, in pixels: the clock and icons sit inside it.
let band = 160

let args = CommandLine.arguments
guard args.count == 5, let seconds = Double(args[2]) else {
    print("usage: app-store-drop-in.swift <capture.mov|.png> <seconds> <simulator capture.png> <out.png>"); exit(2)
}
let input = URL(fileURLWithPath: args[1])

func load(_ url: URL) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

let capture: CGImage
if ["mov", "mp4", "m4v"].contains(input.pathExtension.lowercased()) {
    let generator = AVAssetImageGenerator(asset: AVURLAsset(url: input))
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    capture = try generator.copyCGImage(at: CMTime(seconds: seconds, preferredTimescale: 600), actualTime: nil)
} else {
    guard let image = load(input) else { print("cannot read \(input.path)"); exit(1) }
    capture = image
}
guard let simulator = load(URL(fileURLWithPath: args[3])), simulator.width == width, simulator.height == height else {
    print("the simulator capture must be \(width) × \(height)"); exit(1)
}

// RGBA bitmaps we can read and write pixel by pixel.
func canvas() -> CGContext {
    CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
}

// Fill: scale to cover, centre, crop the overflow.
let out = canvas()
let scale = max(CGFloat(width) / CGFloat(capture.width), CGFloat(height) / CGFloat(capture.height))
let size = CGSize(width: CGFloat(capture.width) * scale, height: CGFloat(capture.height) * scale)
out.interpolationQuality = .high
out.draw(capture, in: CGRect(x: (CGFloat(width) - size.width) / 2, y: (CGFloat(height) - size.height) / 2, width: size.width, height: size.height))
let sim = canvas()
sim.draw(simulator, in: CGRect(x: 0, y: 0, width: width, height: height))

let pixels = out.data!.bindMemory(to: UInt8.self, capacity: width * height * 4)
let glyphs = sim.data!.bindMemory(to: UInt8.self, capacity: width * height * 4)
// Memory runs top row first. The capture's background: its top-left pixel, in the band.
let ground = (0..<3).map { Double(pixels[4 * 8 + $0]) }
let simGround = (0..<3).map { Double(glyphs[4 * 8 + $0]) }
let ink: Double = (ground.reduce(0, +) / 3) < 128 ? 255 : 0
for y in 0..<band {
    for x in 0..<width {
        let i = 4 * (y * width + x)
        // How much glyph covers this pixel: the simulator's dark-on-light, as a coverage.
        let lum = (0..<3).map { Double(glyphs[i + $0]) }.reduce(0, +) / 3
        let cover = max(0, min(1, 1 - lum / max(simGround.reduce(0, +) / 3, 1)))
        for c in 0..<3 { pixels[i + c] = UInt8((ground[c] * (1 - cover) + ink * cover).rounded()) }
    }
}

let file = URL(fileURLWithPath: args[4])
try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
let destination = CGImageDestinationCreateWithURL(file as CFURL, "public.png" as CFString, 1, nil)!
CGImageDestinationAddImage(destination, out.makeImage()!, nil)
guard CGImageDestinationFinalize(destination) else { print("could not write \(file.path)"); exit(1) }
print(file.path)
