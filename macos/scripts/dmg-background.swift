import AppKit

// Render at Retina resolution, retaining a 640 × 420 point canvas for Finder.
let width = 640
let height = 420
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width * 2,
    pixelsHigh: height * 2, bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0)!
bitmap.size = NSSize(width: width, height: height)
let context = NSGraphicsContext(bitmapImageRep: bitmap)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.cgContext.translateBy(x: 0, y: CGFloat(height))
context.cgContext.scaleBy(x: 1, y: -1)

func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
}
func text(_ value: String, x: CGFloat, y: CGFloat, size: CGFloat, weight: NSFont.Weight, ink: NSColor) {
    let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: ink]
    // Text draws upright within the flipped canvas.
    let line = NSAttributedString(string: value, attributes: attributes)
    context.saveGraphicsState()
    context.cgContext.translateBy(x: x, y: y + line.size().height)
    context.cgContext.scaleBy(x: 1, y: -1)
    line.draw(at: .zero)
    context.restoreGraphicsState()
}

color(246, 245, 242).setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: width, height: height)).fill()
color(25, 25, 24).setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: width, height: 174)).fill()
// Mia's dot silhouette, softly cropped at the right edge like onboarding.
context.saveGraphicsState()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: width, height: 174)).addClip()
for row in -4...4 {
    for column in -4...4 where abs(row) + abs(column) <= 4 {
        let alpha: CGFloat = (row + column) % 3 == 0 ? 0.42 : 0.15
        color(195, 159, 77, alpha).setFill()
        let radius: CGFloat = (row + column) % 3 == 0 ? 7 : 5
        NSBezierPath(ovalIn: NSRect(x: 559 + CGFloat(column) * 26 - radius,
            y: 79 + CGFloat(row) * 26 - radius, width: radius * 2, height: radius * 2)).fill()
    }
}
context.restoreGraphicsState()
text("Welcome to Mia", x: 40, y: 40, size: 30, weight: .semibold, ink: .white)
text("Easy, powerful AI for everyone.", x: 41, y: 88, size: 15, weight: .regular, ink: color(187, 185, 179))

let arrow = NSBezierPath()
arrow.move(to: NSPoint(x: 294, y: 259))
arrow.line(to: NSPoint(x: 346, y: 259))
arrow.move(to: NSPoint(x: 336, y: 249))
arrow.line(to: NSPoint(x: 346, y: 259))
arrow.line(to: NSPoint(x: 336, y: 269))
arrow.lineWidth = 2
arrow.lineCapStyle = .round
arrow.lineJoinStyle = .round
color(159, 125, 53).setStroke()
arrow.stroke()
text("Drag Mia into Applications to install.", x: 185, y: 361, size: 14, weight: .regular, ink: color(104, 101, 94))
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
