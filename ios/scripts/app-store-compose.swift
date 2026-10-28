// Frames the App Store screenshots (ios/app-store.md step 6): each raw 1206 × 2622 capture
// from app-store-shots.sh goes inside a drawn iPhone frame (no Apple artwork), under its
// headline on the brand green or the launch grey, with a call-out cropped from the same
// capture where one helps. Writes 1206 × 2622 PNGs with no alpha, App Store Connect's 6.3-inch
// iPhone slot. CoreGraphics and AppKit only.
//
// A capture taken elsewhere (Chat's, from Brad's iPhone: the simulator cannot reach the chat
// server) goes in <out>/drop-in/<slot>.png, e.g. drop-in/5.png, as a raw 1206 × 2622 screenshot.
// It replaces that slot's simulator capture and is framed the same way. Slot 5 with nothing
// dropped in is a marked placeholder.
//   swift ios/scripts/app-store-compose.swift ios/build/app-store-shots ios/build/app-store-assets/screenshots
import AppKit
import ImageIO
import UniformTypeIdentifiers

let width = 1206, height = 2622
let W = CGFloat(width), H = CGFloat(height)

// MARK: Brand (ios/HealthRoadmap/Assets.xcassets, light appearance)

func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: a) }
let accent = rgb(0.043, 0.478, 0.333)      // AccentColor
let accentDeep = rgb(0.024, 0.318, 0.220)  // the accent, darker, for the gradient's foot
let accentLift = rgb(0.075, 0.560, 0.400)  // the accent, lighter, for its head
let launch = rgb(0.949, 0.949, 0.969)      // LaunchBackground
let launchTint = rgb(0.890, 0.937, 0.910)  // the launch grey with a little accent in it
let onAccent = rgb(1, 1, 1)                // OnAccent
let ink = rgb(0.055, 0.165, 0.125)         // headline on the grey: near black, a touch of green

// MARK: Slots

enum Ground { case green, light }

struct Callout {
    /// The crop, in the capture's pixels (top-left origin).
    let crop: CGRect
    /// Its width on the canvas.
    let width: CGFloat
    /// How far its centre moves from where the crop sits on the drawn phone.
    var shift = CGSize.zero
}

struct Slot {
    let number: Int
    let raw: String
    let out: String
    let lines: [String]
    let ground: Ground
    /// The screen's width on the canvas.
    let screenWidth: CGFloat
    /// The phone's centre x and its top edge, on the canvas.
    let centerX: CGFloat
    let top: CGFloat
    var degrees: CGFloat = 0
    var callout: Callout? = nil
    var placeholder: String? = nil
}

// Crops are in the capture's pixels: 1206 × 2622, the 6.3-inch iPhone at 3×.
let slots: [Slot] = [
    // Search shows the first two: the biggest phone, and the plan's first card lifted off it.
    Slot(number: 1, raw: "1 my plan", out: "1-my-plan", lines: ["Your next health steps,", "in one list"], ground: .green,
         screenWidth: 980, centerX: W / 2, top: 540,
         callout: Callout(crop: CGRect(x: 47, y: 480, width: 1112, height: 752), width: 1110, shift: CGSize(width: 0, height: 50))),
    Slot(number: 2, raw: "2 lab reading", out: "2-add-lab-report", lines: ["Add a lab report.", "Check each value."], ground: .light,
         screenWidth: 900, centerX: W / 2, top: 600, degrees: 4,
         callout: Callout(crop: CGRect(x: 40, y: 1101, width: 1126, height: 734), width: 1110)),
    Slot(number: 3, raw: "3 card opened", out: "3-evidence", lines: ["Every step shows", "its evidence"], ground: .green,
         screenWidth: 860, centerX: W / 2 + 130, top: 590,
         callout: Callout(crop: CGRect(x: 66, y: 787, width: 1088, height: 839), width: 1000, shift: CGSize(width: -190, height: 0))),
    Slot(number: 4, raw: "4 my data", out: "4-my-data", lines: ["Your numbers", "in one place"], ground: .light,
         screenWidth: 860, centerX: W / 2 - 130, top: 590,
         callout: Callout(crop: CGRect(x: 47, y: 1455, width: 1112, height: 590), width: 960, shift: CGSize(width: 190, height: 50))),
    Slot(number: 5, raw: "5 chat", out: "5-chat", lines: ["Ask about", "your results"], ground: .green,
         screenWidth: 980, centerX: W / 2, top: 540, placeholder: "Chat capture from iPhone\ngoes here\n\ndrop-in/5.png, 1206 × 2622"),
    Slot(number: 6, raw: "6 sync", out: "6-sync", lines: ["Your record stays", "on your iPhone", "or in your cloud"], ground: .light,
         screenWidth: 900, centerX: W / 2, top: 640),
]

// MARK: Drawing helpers (the canvas is drawn top-left first: y grows downward)

func roundedRect(_ rect: CGRect, _ radius: CGFloat) -> CGPath {
    CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
}

func loadImage(_ url: URL) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

/// Draws an image into `rect` the right way up on the flipped canvas.
func draw(_ image: CGImage, in rect: CGRect, _ ctx: CGContext) {
    ctx.saveGState()
    ctx.translateBy(x: rect.minX, y: rect.maxY)
    ctx.scaleBy(x: 1, y: -1)
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(origin: .zero, size: rect.size))
    ctx.restoreGState()
}

func font(_ size: CGFloat, _ weight: NSFont.Weight) -> NSFont { NSFont.systemFont(ofSize: size, weight: weight) }

func attributed(_ text: String, _ font: NSFont, _ color: CGColor, align: NSTextAlignment = .center, lineHeight: CGFloat? = nil, kern: CGFloat = 0) -> NSAttributedString {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = align
    if let lineHeight { paragraph.minimumLineHeight = lineHeight; paragraph.maximumLineHeight = lineHeight }
    return NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: NSColor(cgColor: color)!, .paragraphStyle: paragraph, .kern: kern])
}

/// Draws text in a box on the flipped canvas (NSGraphicsContext flipped to match).
func drawText(_ text: NSAttributedString, in rect: CGRect, _ ctx: CGContext) {
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
    text.draw(with: rect, options: [.usesLineFragmentOrigin])
    NSGraphicsContext.restoreGraphicsState()
}

// MARK: The headline: one size for all six, the largest at which every line fits

let headlineMax: CGFloat = 108
let headlineWidth: CGFloat = W - 2 * 84
let headlineSize: CGFloat = {
    var size = headlineMax
    for slot in slots {
        for line in slot.lines {
            while attributed(line, font(size, .bold), ink, kern: -size * 0.01).size().width > headlineWidth { size -= 1 }
        }
    }
    return size
}()

// MARK: The phone

/// The drawn iPhone: a dark body a little larger than the screen, a fine lighter rim, the
/// screen inside with its own corners, and the Dynamic Island over the status bar.
func drawPhone(_ screen: CGImage?, screenRect: CGRect, ground: Ground, placeholder: String?, _ ctx: CGContext) {
    let scale = screenRect.width / W
    let bezel = 30 * scale
    let screenRadius = 186 * scale
    let body = screenRect.insetBy(dx: -bezel, dy: -bezel)
    let bodyRadius = screenRadius + bezel

    // Soft depth: a wide, low shadow, then a tight one at the edge.
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: 60), blur: 120, color: rgb(0, 0.08, 0.05, ground == .green ? 0.55 : 0.28))
    ctx.addPath(roundedRect(body, bodyRadius)); ctx.setFillColor(rgb(0.09, 0.09, 0.10)); ctx.fillPath()
    ctx.restoreGState()
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: 6), blur: 14, color: rgb(0, 0, 0, 0.25))
    ctx.addPath(roundedRect(body, bodyRadius)); ctx.setFillColor(rgb(0.09, 0.09, 0.10)); ctx.fillPath()
    ctx.restoreGState()

    // The rim: a lighter band at the very edge, brighter at the top, like brushed metal.
    ctx.saveGState()
    ctx.addPath(roundedRect(body.insetBy(dx: 2, dy: 2), bodyRadius - 2))
    ctx.setLineWidth(5 * max(scale, 0.6))
    ctx.replacePathWithStrokedPath()
    ctx.clip()
    let rim = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [rgb(0.62, 0.63, 0.65), rgb(0.30, 0.31, 0.33), rgb(0.48, 0.49, 0.51)] as CFArray, locations: [0, 0.5, 1])!
    ctx.drawLinearGradient(rim, start: CGPoint(x: body.minX, y: body.minY), end: CGPoint(x: body.maxX, y: body.maxY), options: [])
    ctx.restoreGState()

    // The screen.
    ctx.saveGState()
    ctx.addPath(roundedRect(screenRect, screenRadius)); ctx.clip()
    if let screen {
        draw(screen, in: screenRect, ctx)
    } else {
        ctx.setFillColor(launch); ctx.fill(screenRect)
        if let placeholder {
            // Dashed inner border and words: plainly a stand-in, never mistaken for the app.
            ctx.setStrokeColor(rgb(0.6, 0.6, 0.64)); ctx.setLineWidth(4); ctx.setLineDash(phase: 0, lengths: [18, 14])
            ctx.addPath(roundedRect(screenRect.insetBy(dx: 40 * scale, dy: 40 * scale), screenRadius - 40 * scale)); ctx.strokePath()
            let text = attributed(placeholder, font(46, .medium), rgb(0.42, 0.42, 0.46))
            let box = CGRect(x: screenRect.minX + 60, y: screenRect.midY - 160, width: screenRect.width - 120, height: 400)
            drawText(text, in: box, ctx)
        }
    }
    ctx.restoreGState()

    // The Dynamic Island: 126 × 37 pt, 11 pt from the top, on the 402 pt wide screen.
    let island = CGRect(x: screenRect.midX - 189 * scale, y: screenRect.minY + 33 * scale, width: 378 * scale, height: 111 * scale)
    ctx.addPath(roundedRect(island, island.height / 2)); ctx.setFillColor(rgb(0, 0, 0)); ctx.fillPath()
}

/// A crop of the capture, larger, on a card that breaks out past the phone's edge.
func drawCallout(_ callout: Callout, from screen: CGImage, at center: CGPoint, ground: Ground, _ ctx: CGContext) {
    guard let crop = screen.cropping(to: callout.crop) else { return }
    let size = CGSize(width: callout.width, height: callout.width * callout.crop.height / callout.crop.width)
    let rect = CGRect(x: center.x - size.width / 2, y: center.y - size.height / 2, width: size.width, height: size.height)
    let radius: CGFloat = 40
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: 36), blur: 80, color: rgb(0, 0.08, 0.05, ground == .green ? 0.5 : 0.25))
    ctx.addPath(roundedRect(rect, radius)); ctx.setFillColor(rgb(1, 1, 1)); ctx.fillPath()
    ctx.restoreGState()
    ctx.saveGState()
    ctx.addPath(roundedRect(rect, radius)); ctx.clip()
    draw(crop, in: rect, ctx)
    ctx.restoreGState()
    ctx.addPath(roundedRect(rect.insetBy(dx: 1, dy: 1), radius - 1))
    ctx.setStrokeColor(rgb(0, 0, 0, 0.08)); ctx.setLineWidth(2); ctx.strokePath()
}

// MARK: One screenshot

func compose(_ slot: Slot, screen: CGImage?, icon: CGImage?) -> CGImage {
    // RGB with no alpha channel: App Store Connect refuses screenshots with one.
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.translateBy(x: 0, y: H); ctx.scaleBy(x: 1, y: -1) // top-left origin
    ctx.setAllowsAntialiasing(true); ctx.setShouldAntialias(true)
    let space = CGColorSpace(name: CGColorSpace.sRGB)

    // The ground: a gentle vertical gradient, and a soft glow behind the headline.
    let colors: [CGColor] = slot.ground == .green ? [accentLift, accent, accentDeep] : [launch, launch, launchTint]
    let ground = CGGradient(colorsSpace: space, colors: colors as CFArray, locations: [0, 0.45, 1])!
    ctx.drawLinearGradient(ground, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: H), options: [])
    let glowColor = slot.ground == .green ? rgb(1, 1, 1, 0.10) : rgb(1, 1, 1, 0.9)
    let glow = CGGradient(colorsSpace: space, colors: [glowColor, rgb(1, 1, 1, 0)] as CFArray, locations: [0, 1])!
    ctx.drawRadialGradient(glow, startCenter: CGPoint(x: W / 2, y: 260), startRadius: 0, endCenter: CGPoint(x: W / 2, y: 260), endRadius: 900, options: [])

    // The brand line: the app's icon and name.
    let textColor = slot.ground == .green ? onAccent : ink
    let name = attributed("Health Roadmap", font(40, .semibold), slot.ground == .green ? rgb(1, 1, 1, 0.92) : accent, align: .left)
    let iconSize: CGFloat = 64, gap: CGFloat = 18
    let nameWidth = name.size().width
    let brandX = (W - iconSize - gap - nameWidth) / 2
    let brandY: CGFloat = 120
    if let icon {
        ctx.saveGState()
        ctx.addPath(roundedRect(CGRect(x: brandX, y: brandY, width: iconSize, height: iconSize), iconSize * 0.225)); ctx.clip()
        draw(icon, in: CGRect(x: brandX, y: brandY, width: iconSize, height: iconSize), ctx)
        ctx.restoreGState()
        if slot.ground == .green {
            ctx.addPath(roundedRect(CGRect(x: brandX, y: brandY, width: iconSize, height: iconSize).insetBy(dx: 1, dy: 1), iconSize * 0.225))
            ctx.setStrokeColor(rgb(1, 1, 1, 0.35)); ctx.setLineWidth(2); ctx.strokePath()
        }
    }
    drawText(name, in: CGRect(x: brandX + iconSize + gap, y: brandY + (iconSize - name.size().height) / 2, width: nameWidth + 4, height: 60), ctx)

    // The headline.
    let lineHeight = headlineSize * 1.08
    let headline = attributed(slot.lines.joined(separator: "\n"), font(headlineSize, .bold), textColor, lineHeight: lineHeight, kern: -headlineSize * 0.01)
    drawText(headline, in: CGRect(x: 40, y: 236, width: W - 80, height: lineHeight * CGFloat(slot.lines.count) + 40), ctx)

    // The phone, turned if the slot says so.
    let screenSize = CGSize(width: slot.screenWidth, height: slot.screenWidth * H / W)
    let scale = slot.screenWidth / W
    let bezel = 30 * scale
    let screenRect = CGRect(x: slot.centerX - screenSize.width / 2, y: slot.top + bezel, width: screenSize.width, height: screenSize.height)
    ctx.saveGState()
    if slot.degrees != 0 {
        ctx.translateBy(x: screenRect.midX, y: screenRect.midY)
        ctx.rotate(by: slot.degrees * .pi / 180)
        ctx.translateBy(x: -screenRect.midX, y: -screenRect.midY)
    }
    drawPhone(screen, screenRect: screenRect, ground: slot.ground, placeholder: slot.placeholder, ctx)
    ctx.restoreGState()

    if let callout = slot.callout, let screen {
        // Where the crop's centre lands on the drawn (and perhaps turned) phone, then the shift.
        var point = CGPoint(x: screenRect.minX + callout.crop.midX * scale, y: screenRect.minY + callout.crop.midY * scale)
        let turn = slot.degrees * .pi / 180, dx = point.x - screenRect.midX, dy = point.y - screenRect.midY
        point = CGPoint(x: screenRect.midX + dx * cos(turn) - dy * sin(turn), y: screenRect.midY + dx * sin(turn) + dy * cos(turn))
        drawCallout(callout, from: screen, at: CGPoint(x: point.x + callout.shift.width, y: point.y + callout.shift.height), ground: slot.ground, ctx)
    }
    return ctx.makeImage()!
}

// MARK: Main

let args = CommandLine.arguments
guard args.count == 3 else { print("usage: app-store-compose.swift <captures dir> <out dir>"); exit(2) }
let raws = URL(fileURLWithPath: args[1]), out = URL(fileURLWithPath: args[2])
let dropIn = out.appendingPathComponent("drop-in")
try FileManager.default.createDirectory(at: dropIn, withIntermediateDirectories: true)
let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let icon = loadImage(here.appendingPathComponent("../HealthRoadmap/Assets.xcassets/AppIcon.appiconset/AppIcon.png").standardized)

// The UI test measures where its call-outs sit (crops.json, capture pixels): they follow the
// scroll, which lands a little differently each run. The slots' own crops are the fallback.
var measured: [String: [Double]] = [:]
if let data = try? Data(contentsOf: raws.appendingPathComponent("crops.json")),
   let json = try? JSONSerialization.jsonObject(with: data) as? [String: [Double]] { measured = json }

var failed = false
for slot in slots {
    let dropped = dropIn.appendingPathComponent("\(slot.number).png")
    let source = FileManager.default.fileExists(atPath: dropped.path) ? dropped : raws.appendingPathComponent("\(slot.raw).png")
    let screen = loadImage(source)
    if let image = screen, image.width != width || image.height != height {
        print("\(source.path): \(image.width) × \(image.height), not \(width) × \(height): skipped"); failed = true; continue
    }
    if screen == nil && slot.placeholder == nil { print("missing \(source.path)"); failed = true; continue }
    if source == dropped { print("slot \(slot.number): drop-in \(dropped.lastPathComponent)") }
    // A dropped-in capture's layout is unknown: no call-out is cropped from it.
    var slot = slot
    if source == dropped { slot.callout = nil }
    if let callout = slot.callout, source != dropped, let r = measured[String(slot.number)], r.count == 4 {
        slot.callout = Callout(crop: CGRect(x: r[0], y: r[1], width: r[2], height: r[3]).integral, width: callout.width, shift: callout.shift)
    }
    let image = compose(slot, screen: screen, icon: icon)
    let file = out.appendingPathComponent("\(slot.out).png")
    let destination = CGImageDestinationCreateWithURL(file as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { print("could not write \(file.path)"); exit(1) }
    print(file.path)
}
print("headline size \(Int(headlineSize)) px")
exit(failed ? 1 : 0)
