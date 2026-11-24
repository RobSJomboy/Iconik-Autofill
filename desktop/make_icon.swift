// Renders the app icon (navy rounded square, gold up-arrow into a tray) → icon_1024.png
import AppKit
let S: CGFloat = 1024
let img = NSImage(size: NSSize(width: S, height: S))
img.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext
let r = NSRect(x: 100, y: 100, width: 824, height: 824)
let bg = NSBezierPath(roundedRect: r, xRadius: 185, yRadius: 185)
NSGradient(colors: [NSColor(red: 0.10, green: 0.18, blue: 0.34, alpha: 1), NSColor(red: 0.03, green: 0.07, blue: 0.15, alpha: 1)])!.draw(in: bg, angle: -90)
NSColor(red: 0.84, green: 0.70, blue: 0.30, alpha: 0.35).setStroke(); bg.lineWidth = 6; bg.stroke()
let gold = NSColor(red: 0.86, green: 0.71, blue: 0.30, alpha: 1)
gold.setFill(); gold.setStroke()
// tray
let tray = NSBezierPath()
tray.move(to: NSPoint(x: 290, y: 470)); tray.line(to: NSPoint(x: 290, y: 300)); tray.line(to: NSPoint(x: 734, y: 300)); tray.line(to: NSPoint(x: 734, y: 470))
tray.lineWidth = 58; tray.lineCapStyle = .round; tray.lineJoinStyle = .round; tray.stroke()
// arrow
let a = NSBezierPath()
a.move(to: NSPoint(x: 512, y: 760)); a.line(to: NSPoint(x: 680, y: 590)); a.line(to: NSPoint(x: 572, y: 590))
a.line(to: NSPoint(x: 572, y: 400)); a.line(to: NSPoint(x: 452, y: 400)); a.line(to: NSPoint(x: 452, y: 590)); a.line(to: NSPoint(x: 344, y: 590)); a.close()
a.lineJoinStyle = .round; a.fill()
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
