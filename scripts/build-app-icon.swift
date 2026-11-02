#!/usr/bin/env swift
// 原创 App 图标的单一几何源。仅使用 macOS AppKit/CoreGraphics，离线导出 SVG/PNG/ICNS。
import AppKit
import Foundation

struct Shade {
    let hex: String
    var alpha: CGFloat = 1
    var color: CGColor {
        let n = UInt32(hex.dropFirst(), radix: 16)!
        return CGColor(red: CGFloat((n >> 16) & 255) / 255,
                       green: CGFloat((n >> 8) & 255) / 255,
                       blue: CGFloat(n & 255) / 255, alpha: alpha)
    }
}

// 色板只借鉴用户截图的柔白、青蓝、粉紫与浅桃；不嵌入或描摹参考图标。
struct GradientSpec {
    let start: CGPoint
    let end: CGPoint
    let stops: [(String, CGFloat, CGFloat)] // hex、位置、透明度
    var radius: CGFloat? = nil

    func draw(_ context: CGContext) {
        let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
            colors: stops.map { Shade(hex: $0.0, alpha: $0.2).color } as CFArray,
            locations: stops.map { $0.1 })!
        if let radius {
            context.drawRadialGradient(gradient, startCenter: start, startRadius: 0,
                endCenter: start, endRadius: radius, options: [.drawsAfterEndLocation])
        } else {
            context.drawLinearGradient(gradient, start: start, end: end,
                options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        }
    }
    func svg(id: String) -> String {
        let content = stops.map { "<stop offset=\"\($0.1)\" stop-color=\"\($0.0)\" stop-opacity=\"\($0.2)\"/>" }.joined()
        if let radius {
            return "<radialGradient id=\"\(id)\" gradientUnits=\"userSpaceOnUse\" cx=\"\(start.x)\" cy=\"\(start.y)\" r=\"\(radius)\">\(content)</radialGradient>"
        }
        return "<linearGradient id=\"\(id)\" gradientUnits=\"userSpaceOnUse\" x1=\"\(start.x)\" y1=\"\(start.y)\" x2=\"\(end.x)\" y2=\"\(end.y)\">\(content)</linearGradient>"
    }
}
let gradients: [String: GradientSpec] = [
    "pearl": GradientSpec(start: CGPoint(x: 180, y: 64), end: CGPoint(x: 850, y: 960),
        stops: [("#FFFFFF", 0, 1), ("#EFF0F8", 1, 1)]),
    "sky": GradientSpec(start: CGPoint(x: 512, y: 144), end: CGPoint(x: 512, y: 880),
        stops: [("#22D8F2", 0, 1), ("#459EFA", 0.3, 1), ("#B29CF4", 0.67, 1), ("#F4BFE7", 1, 1)]),
    "cyanGlow": GradientSpec(start: CGPoint(x: 762, y: 222), end: .zero,
        stops: [("#38F2F4", 0, 0.95), ("#38F2F4", 1, 0)], radius: 460),
    "peachGlow": GradientSpec(start: CGPoint(x: 218, y: 832), end: .zero,
        stops: [("#FFE0D0", 0, 1), ("#FFE0D0", 1, 0)], radius: 550),
    "lilacGlow": GradientSpec(start: CGPoint(x: 810, y: 680), end: .zero,
        stops: [("#C87CE9", 0, 0.65), ("#C87CE9", 1, 0)], radius: 420),
    "starlight": GradientSpec(start: CGPoint(x: 430, y: 300), end: CGPoint(x: 670, y: 690),
        stops: [("#FFFFFF", 0, 1), ("#F4F2FF", 0.6, 1), ("#DFDEFF", 1, 1)]),
]

enum Geometry {
    case box(CGRect, CGFloat)
    case oval(CGRect)
    case path(String)

    var cgPath: CGPath {
        switch self {
        case .box(let r, let radius):
            return CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil)
        case .oval(let r): return CGPath(ellipseIn: r, transform: nil)
        case .path(let data):
            // 图标几何仅使用绝对 M/L/C/Q/Z；解析失败必须中止，不输出残缺图标。
            let tokens = data.split(separator: " ").map(String.init)
            let p = CGMutablePath()
            var i = 0
            func number() -> CGFloat {
                precondition(i < tokens.count, "路径坐标缺失")
                let value = Double(tokens[i]); i += 1
                precondition(value != nil, "无效路径坐标")
                return CGFloat(value!)
            }
            func point() -> CGPoint { CGPoint(x: number(), y: number()) }
            while i < tokens.count {
                let op = tokens[i]; i += 1
                switch op {
                case "M": p.move(to: point())
                case "L": p.addLine(to: point())
                case "C":
                    let a = point(), b = point(), c = point()
                    p.addCurve(to: c, control1: a, control2: b)
                case "Q":
                    let a = point(), b = point(); p.addQuadCurve(to: b, control: a)
                case "Z": p.closeSubpath()
                default: preconditionFailure("不支持的路径指令: \(op)")
                }
            }
            return p
        }
    }

    var svg: String {
        switch self {
        case .box(let r, let radius):
            return "rect x=\"\(r.minX)\" y=\"\(r.minY)\" width=\"\(r.width)\" height=\"\(r.height)\" rx=\"\(radius)\""
        case .oval(let r):
            return "ellipse cx=\"\(r.midX)\" cy=\"\(r.midY)\" rx=\"\(r.width / 2)\" ry=\"\(r.height / 2)\""
        case .path(let data): return "path d=\"\(data)\""
        }
    }
}

struct Shape {
    let geometry: Geometry
    let fill: String
    let stroke: String?
    let width: CGFloat
    let opacity: CGFloat
    init(_ geometry: Geometry, _ fill: String = "none", stroke: String? = nil, width: CGFloat = 0, opacity: CGFloat = 1) {
        self.geometry = geometry; self.fill = fill; self.stroke = stroke; self.width = width; self.opacity = opacity
    }
    var svg: String {
        let paint = gradients[fill] != nil ? "url(#\(fill))" : fill
        let outline = stroke.map { " stroke=\"\($0)\" stroke-width=\"\(width)\" stroke-linecap=\"round\" stroke-linejoin=\"round\"" } ?? ""
        return "<\(geometry.svg) fill=\"\(paint)\" opacity=\"\(opacity)\"\(outline)/>"
    }
    func draw(_ context: CGContext) {
        context.saveGState()
        defer { context.restoreGState() }
        context.setAlpha(opacity)
        let path = geometry.cgPath
        if let gradient = gradients[fill] {
            context.saveGState()
            context.addPath(path); context.clip()
            gradient.draw(context)
            context.restoreGState()
        } else if fill != "none" {
            context.setFillColor(Shade(hex: fill).color)
            context.addPath(path); context.fillPath()
        }
        if let color = stroke {
            context.setStrokeColor(Shade(hex: color).color); context.setLineWidth(width)
            context.setLineCap(.round); context.setLineJoin(.round)
            context.addPath(path); context.strokePath()
        }
    }
}

// “伴星窗口”：App 产品标识，不是白龙角色头像。不含官方平台标志、聊天入口或角色素材。
let shapes: [Shape] = [
    // 柔白外框包住青蓝—粉紫渐层，呼应截图的配色而非镜头图形。
    Shape(.box(CGRect(x: 64, y: 64, width: 896, height: 896), 200), "pearl"),
    Shape(.box(CGRect(x: 66, y: 66, width: 892, height: 892), 198), stroke: "#E0E2EF", width: 2),
    Shape(.box(CGRect(x: 144, y: 144, width: 736, height: 736), 142), "sky"),
    Shape(.box(CGRect(x: 144, y: 144, width: 736, height: 736), 142), "cyanGlow"),
    Shape(.box(CGRect(x: 144, y: 144, width: 736, height: 736), 142), "peachGlow"),
    Shape(.box(CGRect(x: 144, y: 144, width: 736, height: 736), 142), "lilacGlow"),
    // 紫灰窗口在明亮背景上仍能被辨认；白色伴星保持主视觉。
    Shape(.box(CGRect(x: 224, y: 328, width: 576, height: 400), 86), "#5D5594", opacity: 0.14),
    Shape(.box(CGRect(x: 224, y: 302, width: 576, height: 400), 86), "#FFFFFF", opacity: 0.18),
    Shape(.box(CGRect(x: 224, y: 302, width: 576, height: 400), 86), stroke: "#49446E", width: 42),
    Shape(.path("M 250 406 L 394 406"), stroke: "#49446E", width: 18, opacity: 0.65),
    Shape(.box(CGRect(x: 408, y: 764, width: 208, height: 36), 18), "#49446E"),
    // 四瓣圆润伴星从窗口边缘探出；不同于动物头部、月牙或平台商标。
    Shape(.path("M 575 267 C 595 267 605 284 614 319 L 645 423 L 749 454 C 784 463 801 473 801 493 C 801 513 784 523 749 532 L 645 563 L 614 667 C 605 702 595 719 575 719 C 555 719 545 702 536 667 L 505 563 L 401 532 C 366 523 349 513 349 493 C 349 473 366 463 401 454 L 505 423 L 536 319 C 545 284 555 267 575 267 Z"), "#5F5192", opacity: 0.22),
    Shape(.path("M 575 247 C 591 247 600 263 609 295 L 640 403 L 748 434 C 780 443 796 452 796 468 C 796 484 780 493 748 502 L 640 533 L 609 641 C 600 673 591 689 575 689 C 559 689 550 673 541 641 L 510 533 L 402 502 C 370 493 354 484 354 468 C 354 452 370 443 402 434 L 510 403 L 541 295 C 550 263 559 247 575 247 Z"), "starlight"),
    // 以一个小暖色伴星表现多实例，不使用眼睛/聊天气泡或具体动物特征。
    Shape(.oval(CGRect(x: 737, y: 219, width: 84, height: 84)), "#64568F", opacity: 0.18),
    Shape(.oval(CGRect(x: 737, y: 205, width: 84, height: 84)), "#FFF2CD"),
]

func png(side: Int) -> Data {
    // 小图独立超采样，不直接缩放低分辨率中间图。
    let pixels = max(side * 2, 256)
    let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8,
                            bytesPerRow: pixels * 4, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.translateBy(x: 0, y: CGFloat(pixels))
    context.scaleBy(x: CGFloat(pixels) / 1024, y: -CGFloat(pixels) / 1024)
    for shape in shapes { shape.draw(context) }
    let source = context.makeImage()!
    let out = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8,
                        bytesPerRow: side * 4, space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    out.interpolationQuality = .high
    out.draw(source, in: CGRect(x: 0, y: 0, width: side, height: side))
    return NSBitmapImageRep(cgImage: out.makeImage()!).representation(using: .png, properties: [:])!
}

func main() throws {
    guard CommandLine.arguments.count == 2 else {
        fputs("Usage: swift scripts/build-app-icon.swift <output-directory>\n", stderr)
        exit(2)
    }
    let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let defs = "<defs>\n" + gradients.keys.sorted().map { gradients[$0]!.svg(id: $0) }.joined(separator: "\n") + "\n</defs>"
    let svg = """
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-labelledby="title desc">
    <title id="title">Anime Desktop Pets — 伴星窗口</title>
    <desc id="desc">柔白圆角外框、青蓝粉紫渐层、紫灰桌面窗口、白色伴星与奶油色卫星。不代表白龙或官方 AI 平台。</desc>
    \(defs)
    \(shapes.map(\.svg).joined(separator: "\n"))
    </svg>
    """
    try (svg + "\n").write(to: directory.appendingPathComponent("app-icon.svg"), atomically: true, encoding: .utf8)
    try png(side: 1024).write(to: directory.appendingPathComponent("app-icon.png"))
    let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("anime-pets-icon-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: temporary) }
    let iconset = temporary.appendingPathComponent("AppIcon.iconset")
    try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
    for size in [16, 32, 128, 256, 512] {
        try png(side: size).write(to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
        try png(side: size * 2).write(to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
    process.arguments = ["-c", "icns", iconset.path, "-o", directory.appendingPathComponent("AppIcon.icns").path]
    try process.run(); process.waitUntilExit()
    guard process.terminationStatus == 0 else { throw NSError(domain: "AppIcon", code: Int(process.terminationStatus)) }
    print("Exported original App icon: SVG, 1024px PNG and multi-size ICNS → \(directory.path)")
}

do { try main() } catch { fputs("App icon: \(error)\n", stderr); exit(1) }
