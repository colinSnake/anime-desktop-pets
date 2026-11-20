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

// “角语”：用户选择的 B 方案，双角外轮廓与中央对话菱形。
// 将原 64pt SVG 的坐标统一映射为 x = 64 + 14x、y = 50 + 14y，保持左右对称。
let shapes: [Shape] = [
    Shape(.box(CGRect(x: 64, y: 64, width: 896, height: 896), 200), "pearl"),
    Shape(.box(CGRect(x: 66, y: 66, width: 892, height: 892), 198), stroke: "#E0E2EF", width: 2),
    Shape(.box(CGRect(x: 144, y: 144, width: 736, height: 736), 142), "sky"),
    Shape(.box(CGRect(x: 144, y: 144, width: 736, height: 736), 142), "cyanGlow"),
    Shape(.box(CGRect(x: 144, y: 144, width: 736, height: 736), 142), "peachGlow"),
    Shape(.box(CGRect(x: 144, y: 144, width: 736, height: 736), 142), "lilacGlow"),
    Shape(.path("M 218 218 L 470 358 L 414 456 L 316 400 L 344 582 L 512 680 L 680 582 L 708 400 L 610 456 L 554 358 L 806 218 L 778 638 L 512 806 L 246 638 L 218 218 Z"), "starlight"),
    Shape(.path("M 414 526 L 512 582 L 610 526 L 512 470 L 414 526 Z"), "#FFF2CD"),
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
    <title id="title">桌边小崽 — 角语</title>
    <desc id="desc">柔白圆角底座、青蓝粉紫渐层、对称的柔白双角折线与奶油色对话菱形。桌边小崽独立应用标识。</desc>
    \(defs)
    \(shapes.map(\.svg).joined(separator: "\n"))
    </svg>
    """
    try (svg + "\n").write(to: directory.appendingPathComponent("app-icon.svg"), atomically: true, encoding: .utf8)
    try png(side: 1024).write(to: directory.appendingPathComponent("app-icon.png"))
    print("Exported original App icon: SVG and 1024px PNG → \(directory.path)")
}

do { try main() } catch { fputs("App icon: \(error)\n", stderr); exit(1) }
