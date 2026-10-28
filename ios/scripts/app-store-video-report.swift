// Draws the fictional lab report the App Store preview video reads (ios/scripts/app-store-video.sh).
// Nobody's results: an invented patient, an invented lab, values made up for the video, each
// printed in the units the app files. Marked "Example" so nobody mistakes it for a real report.
//   swift ios/scripts/app-store-video-report.swift <out.png>
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "report.png")
let width = 1240, height = 1754 // A4 at 150 dpi
let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
ctx.translateBy(x: 0, y: CGFloat(height))
ctx.scaleBy(x: 1, y: -1)
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()

func text(_ s: String, _ x: CGFloat, _ y: CGFloat, size: CGFloat, weight: NSFont.Weight = .regular,
          color: NSColor = .black, align: NSTextAlignment = .left, w: CGFloat = 0) {
    let style = NSMutableParagraphStyle()
    style.alignment = align
    let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size, weight: weight),
                                                .foregroundColor: color, .paragraphStyle: style]
    let str = NSAttributedString(string: s, attributes: attrs)
    if w > 0 { str.draw(in: NSRect(x: x, y: y, width: w, height: size * 1.5)) } else { str.draw(at: NSPoint(x: x, y: y)) }
}
func line(_ y: CGFloat, _ color: NSColor = .lightGray, _ thick: CGFloat = 2) {
    color.setFill(); NSRect(x: 90, y: y, width: CGFloat(width) - 180, height: thick).fill()
}

let ink = NSColor(srgbRed: 0.10, green: 0.16, blue: 0.24, alpha: 1)
let grey = NSColor(srgbRed: 0.42, green: 0.45, blue: 0.50, alpha: 1)
let band = NSColor(srgbRed: 0.16, green: 0.33, blue: 0.55, alpha: 1)
band.setFill(); NSRect(x: 0, y: 0, width: width, height: 150).fill()
text("Example Pathology Laboratory", 90, 40, size: 44, weight: .bold, color: .white)
text("Example report  ·  fictional patient", 90, 98, size: 24, color: NSColor(white: 1, alpha: 0.85))

text("Patient", 90, 200, size: 24, color: grey); text("Sample Patient", 300, 200, size: 26, weight: .semibold, color: ink)
text("Sex", 90, 245, size: 24, color: grey); text("Female", 300, 245, size: 26, color: ink)
text("Collected", 700, 200, size: 24, color: grey); text("12 May 2026", 880, 200, size: 26, weight: .semibold, color: ink)
text("Reported", 700, 245, size: 24, color: grey); text("13 May 2026", 880, 245, size: 26, color: ink)
line(310, ink, 3)

text("Test", 90, 340, size: 24, weight: .semibold, color: grey)
text("Result", 520, 340, size: 24, weight: .semibold, color: grey)
text("Units", 680, 340, size: 24, weight: .semibold, color: grey)
text("Reference", 960, 340, size: 24, weight: .semibold, color: grey)
line(385)

// The values the App Store screenshots' record holds beyond the sample (app-store-shots.sh), on the
// sample's own test day: once read, the record matches the screenshots and the Chat clip.
let sections: [(String, [(String, String, String, String, Bool)])] = [
    ("LIPIDS", [("Total cholesterol", "5.6", "mmol/L", "< 5.5", true),
                ("Triglycerides", "1.2", "mmol/L", "< 1.7", false),
                ("Apolipoprotein B", "1.02", "g/L", "0.55 – 1.05", false),
                ("Lipoprotein(a)", "38", "nmol/L", "< 75", false)]),
    ("KIDNEY", [("Creatinine", "71", "µmol/L", "45 – 90", false)]),
]
var y: CGFloat = 410
for (title, rows) in sections {
    text(title, 90, y, size: 22, weight: .bold, color: band)
    y += 48
    for (name, value, unit, ref, flag) in rows {
        text(name, 90, y, size: 30, color: ink)
        text(value + (flag ? "  H" : ""), 520, y, size: 30, weight: flag ? .bold : .regular, color: ink)
        text(unit, 680, y, size: 26, color: grey)
        text(ref, 960, y + 2, size: 26, color: grey)
        y += 60
    }
    y += 22
}
line(y)
text("H = above the reference interval.", 90, y + 30, size: 22, color: grey)
text("This report is an example made for a product video. The patient and the results are invented.",
     90, CGFloat(height) - 110, size: 22, color: grey)

NSGraphicsContext.current = nil
let png = NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])!
try! png.write(to: out)
print("wrote", out.path)
