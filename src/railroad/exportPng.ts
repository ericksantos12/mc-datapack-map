import * as M from "./model.js"
import type { BiomeRegionRenderer } from "./mapContext.js"
import { schematize } from "./schematize.js"
import type { RailLine, RailNode, RailProject } from "./types.js"

export type PosterLabels = {
    lines: string
    legend: string
    station: string
    interchange: string
    terminal: string
    depot: string
    transfer: string
    service: string
    blocks: string
    double: string
    single: string
    lineStats: (line: RailLine, stops: number, length: number, seconds: number) => string
}

export type PosterOptions = {
    title: string
    subtitle: string
    footer: string
    /** pixel size of the longer canvas side */
    longSide: number
    /** 0..1 opacity of the white metro map panel above the seed map */
    panelOpacity: number
    showBackground: boolean
    showLegend: boolean
    showIntegrations: boolean
    showServiceTracks: boolean
    showDepots: boolean
    showScale: boolean
    /** geographic: real positions; schematic: simplified metro-style octilinear layout */
    layout: 'geographic' | 'schematic'
    labels: PosterLabels
}

const FONT = `"Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif`
const INK = '#1d1d1b'
// stays below the canvas area limit of Safari / iOS (16.7M px)
const MAX_PIXELS = 16_000_000

type Rect = { x: number, y: number, w: number, h: number }
type Seg = { x1: number, y1: number, x2: number, y2: number }

export class EmptyNetworkError extends Error { }

/**
 * Renders a metro-map style poster of the railroad network:
 * the seed's biome map in the background, a white panel with title, lines, stations,
 * their names and integrations, and a legend.
 */
export async function renderPoster(source: RailProject, opts: PosterOptions, renderBiome?: BiomeRegionRenderer, onProgress?: (f: number) => void): Promise<HTMLCanvasElement> {
    const sourceNodes = M.nodeMap(source)
    const sourceLines = source.lines.filter(l => l.nodeIds.length >= 2 && (opts.showServiceTracks || l.kind === 'line'))
    const schematic = opts.layout === 'schematic'
    // the diagram is drawn from `project`: either the real network or its simplified schematic
    const project = schematic ? schematize(source, sourceLines) : source
    const nodes = M.nodeMap(project)
    const lines = project.lines.filter(l => l.nodeIds.length >= 2 && (opts.showServiceTracks || l.kind === 'line'))
    const mainLines = lines.filter(l => l.kind === 'line')
    const usedByLines = new Set(lines.flatMap(l => l.nodeIds))
    const named = project.nodes.filter(n => n.type !== 'waypoint' && (opts.showDepots || n.type !== 'depot'))
        // depots are only drawn when shown, stations always
        .filter(n => n.type !== 'depot' || opts.showDepots)
    const visibleNodes = project.nodes.filter(n => usedByLines.has(n.id) || named.includes(n))
    if (visibleNodes.length === 0) throw new EmptyNetworkError('empty network')

    // ---------- world bounds ----------
    let { minX, minZ, maxX, maxZ } = M.bounds(visibleNodes)
    const minSpan = Math.max(64, 0.2 * Math.max(maxX - minX, maxZ - minZ))
    if (maxX - minX < minSpan) { const c = (minX + maxX) / 2; minX = c - minSpan / 2; maxX = c + minSpan / 2 }
    if (maxZ - minZ < minSpan) { const c = (minZ + maxZ) / 2; minZ = c - minSpan / 2; maxZ = c + minSpan / 2 }
    let bw = maxX - minX, bh = maxZ - minZ
    if (bw / bh > 2.4) { const c = (minZ + maxZ) / 2; bh = bw / 2.4; minZ = c - bh / 2; maxZ = c + bh / 2 }
    if (bw / bh < 0.55) { const c = (minX + maxX) / 2; bw = bh * 0.55; minX = c - bw / 2; maxX = c + bw / 2 }

    // ---------- layout (all sizes relative to a 1600px poster) ----------
    let longSide = opts.longSide
    let u = longSide / 1600
    const layout = () => {
        const m = 48 * u, header = 150 * u, pad = 80 * u
        const legendHeight = (W: number) => {
            if (!opts.showLegend) return 40 * u
            const cols = Math.max(1, Math.floor((W - 2 * m - 88 * u) / (380 * u)))
            const rows = Math.ceil(mainLines.length / cols)
            return 70 * u + rows * 50 * u + 80 * u
        }
        let W: number, H: number, k: number
        if (bw >= bh) {
            W = longSide
            k = (W - 2 * m - 2 * pad) / bw
            H = 2 * m + header + 2 * pad + bh * k + legendHeight(W)
        } else {
            H = longSide
            const guessW = Math.max(longSide * 0.7, 900 * u)
            k = (H - 2 * m - header - 2 * pad - legendHeight(guessW)) / bh
            W = Math.max(bw * k + 2 * m + 2 * pad, guessW)
            k = Math.min(k, (W - 2 * m - 2 * pad) / bw)
            H = 2 * m + header + 2 * pad + bh * k + legendHeight(W)
        }
        return { m, header, pad, W: Math.round(W), H: Math.round(H), k, legendH: legendHeight(W) }
    }
    let L = layout()
    if (L.W * L.H > MAX_PIXELS) {
        longSide = longSide * Math.sqrt(MAX_PIXELS / (L.W * L.H))
        u = longSide / 1600
        L = layout()
    }
    const { m, header, pad, W, H, k } = L
    const diagramW = bw * k, diagramH = bh * k
    const ox = (W - diagramW) / 2
    const oy = m + header + pad
    const X = (x: number) => ox + (x - minX) * k
    const Y = (z: number) => oy + (z - minZ) * k

    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!
    ctx.textBaseline = 'alphabetic'

    // ---------- background: seed map ----------
    ctx.fillStyle = '#d9dee2'
    ctx.fillRect(0, 0, W, H)
    if (opts.showBackground && renderBiome) {
        let wx0 = minX - ox / k, wz0 = minZ - oy / k, wx1 = wx0 + W / k, wz1 = wz0 + H / k
        if (schematic) {
            // positions are abstract: show the real area of the network, scaled to cover the poster
            const used = new Set(sourceLines.flatMap(l => l.nodeIds))
            const g = M.bounds(source.nodes.filter(n => used.has(n.id) || n.type !== 'waypoint'))
            const gw = Math.max(64, g.maxX - g.minX) * 1.3, gh = Math.max(64, g.maxZ - g.minZ) * 1.3
            const s = Math.max(gw / W, gh / H)
            const cx = (g.minX + g.maxX) / 2, cz = (g.minZ + g.maxZ) / 2
            wx0 = cx - W * s / 2; wx1 = cx + W * s / 2; wz0 = cz - H * s / 2; wz1 = cz + H * s / 2
        }
        const bg = await renderBiome(wx0, wz0, wx1, wz1, W, H, onProgress)
        ctx.drawImage(bg, 0, 0, W, H)
    }
    onProgress?.(1)

    // ---------- white panel ----------
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.35)'
    ctx.shadowBlur = 30 * u
    ctx.shadowOffsetY = 6 * u
    roundRect(ctx, m, m, W - 2 * m, H - 2 * m, 26 * u)
    ctx.fillStyle = `rgba(255,255,255,${clamp(opts.panelOpacity, 0, 1)})`
    ctx.fill()
    ctx.restore()

    // ---------- header ----------
    const innerL = m + 44 * u, innerR = W - m - 44 * u
    ctx.fillStyle = INK
    const titleSize = fitFont(ctx, opts.title, `800 {s}px ${FONT}`, 58 * u, innerR - innerL - 120 * u)
    ctx.font = `800 ${titleSize}px ${FONT}`
    ctx.fillText(opts.title, innerL, m + 82 * u)
    if (opts.subtitle) {
        ctx.font = `400 ${24 * u}px ${FONT}`
        ctx.fillStyle = '#5f6368'
        ctx.fillText(ellipsize(ctx, opts.subtitle, innerR - innerL - 120 * u), innerL, m + 120 * u)
    }
    // colored stripe made of the line colors
    const stripeY = m + header - 12 * u
    const stripeColors = mainLines.length > 0 ? mainLines.map(l => l.color) : ['#9e9e9e']
    const stripeW = (innerR - innerL) / stripeColors.length
    stripeColors.forEach((c, i) => {
        ctx.fillStyle = c
        ctx.fillRect(innerL + i * stripeW, stripeY, stripeW + 0.5, 8 * u)
    })
    drawNorthArrow(ctx, innerR - 34 * u, m + 70 * u, 30 * u)

    // ---------- geometry of the diagram ----------
    const lw = 11 * u
    const spacing = lw * 1.1
    const usage = M.segmentUsage({ ...project, lines })
    const obstacles: Seg[] = []
    const segPoints = (line: RailLine) => {
        const result: { a: RailNode, b: RailNode, x1: number, y1: number, x2: number, y2: number }[] = []
        for (let i = 1; i < line.nodeIds.length; i++) {
            const a = nodes.get(line.nodeIds[i - 1]), b = nodes.get(line.nodeIds[i])
            if (!a || !b) continue
            let x1 = X(a.x), y1 = Y(a.z), x2 = X(b.x), y2 = Y(b.z)
            const off = M.laneOffset(usage, a.id, b.id, line.id) * spacing
            if (off !== 0) {
                const [fx, fy, tx, ty] = a.id < b.id ? [x1, y1, x2, y2] : [x2, y2, x1, y1]
                const len = Math.hypot(tx - fx, ty - fy) || 1
                const sx = -(ty - fy) / len * off, sy = (tx - fx) / len * off
                x1 += sx; y1 += sy; x2 += sx; y2 += sy
            }
            result.push({ a, b, x1, y1, x2, y2 })
        }
        return result
    }

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // service tracks first (thin, dashed)
    for (const line of lines.filter(l => l.kind === 'service')) {
        for (const s of segPoints(line)) {
            strokeSeg(ctx, s, '#ffffff', lw * 0.45 + 5 * u)
            ctx.setLineDash([lw * 0.9, lw * 0.7])
            strokeSeg(ctx, s, line.color, lw * 0.45, 'butt')
            ctx.setLineDash([])
            obstacles.push(s)
        }
    }
    // casing, then colors
    const mainSegs = mainLines.map(line => ({ line, segs: segPoints(line) }))
    for (const { segs } of mainSegs) for (const s of segs) strokeSeg(ctx, s, '#ffffff', lw + 6 * u)
    for (const { line, segs } of mainSegs) for (const s of segs) {
        strokeSeg(ctx, s, line.color, lw)
        // double track: light stripe in the middle (same convention as the editor map)
        if (M.trackType(project, s.a.id, s.b.id) === 'double') strokeSeg(ctx, s, 'rgba(255,255,255,0.9)', Math.max(1, lw * 0.18), 'butt')
        obstacles.push(s)
    }

    // ---------- stations ----------
    type Placed = { node: RailNode, x: number, y: number, r: number, integ: M.Integrations, interchange: boolean }
    const placed: Placed[] = []
    const lanesAt = (nodeId: string) => {
        let max = 1
        for (const [key, ids] of usage) {
            if (key.startsWith(nodeId + '|') || key.endsWith('|' + nodeId)) max = Math.max(max, ids.filter(id => mainLines.some(l => l.id === id)).length)
        }
        return max
    }
    for (const node of named) {
        const integ = M.integrationsOf({ ...project, lines }, node.id, nodes)
        const interchange = M.isInterchange(integ)
        const lanes = lanesAt(node.id)
        let r = interchange ? lw * 0.85 + (lanes - 1) * spacing / 2 : lw * 0.68
        if (node.type === 'terminal') r = Math.max(r, lw * 0.95)
        if (node.type === 'depot') r = lw * 1.0
        placed.push({ node, x: X(node.x), y: Y(node.z), r, integ, interchange })
    }

    // transfer connectors (below the station symbols)
    for (const t of project.transfers) {
        const a = placed.find(p => p.node.id === t.a), b = placed.find(p => p.node.id === t.b)
        if (!a || !b) continue
        const s = { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
        strokeSeg(ctx, s, INK, lw * 0.9 + 6 * u)
        strokeSeg(ctx, s, '#ffffff', lw * 0.9 - 1 * u)
        obstacles.push(s)
    }

    for (const p of placed) drawStation(ctx, p.node, p.x, p.y, p.r, p.integ, p.interchange, lw, u)

    // ---------- labels ----------
    const labelRects: Rect[] = []
    const stationRects: Rect[] = placed.map(p => ({ x: p.x - p.r, y: p.y - p.r, w: 2 * p.r, h: 2 * p.r }))
    const diagramArea: Rect = { x: m + 8 * u, y: m + header, w: W - 2 * m - 16 * u, h: H - 2 * m - header - L.legendH + pad * 0.6 }
    const priority = (p: Placed) => p.node.type === 'terminal' ? 0 : p.interchange ? 1 : p.node.type === 'station' ? 2 : 3
    for (const p of [...placed].sort((a, b) => priority(a) - priority(b))) {
        if (!p.node.name && !(opts.showIntegrations && p.integ.text)) continue
        const block = measureLabel(ctx, p, opts, u)
        const gap = 7 * u
        const candidates = labelCandidates(p.x, p.y, p.r + gap, block.w, block.h)
        let best = candidates[0], bestScore = Infinity
        candidates.forEach((c, index) => {
            let score = index * 0.5
            if (!contains(diagramArea, c.rect)) score += 1000
            for (const r of labelRects) if (intersects(r, c.rect)) score += 120
            for (const r of stationRects) if (intersects(r, c.rect)) score += 60
            for (const s of obstacles) if (segIntersectsRect(s, inflate(c.rect, lw * 0.4))) score += 12
            if (score < bestScore) { bestScore = score; best = c }
        })
        labelRects.push(best.rect)
        drawLabel(ctx, p, block, best.rect, best.align, opts, u)
    }

    // ---------- scale bar ----------
    const legendTop = H - m - L.legendH
    if (opts.showScale && !schematic) {
        drawScaleBar(ctx, innerL, legendTop - 18 * u, k, u, opts.labels.blocks)
    }

    // ---------- legend ----------
    if (opts.showLegend) {
        ctx.fillStyle = '#e0e0e0'
        ctx.fillRect(innerL, legendTop, innerR - innerL, 2 * u)
        ctx.fillStyle = INK
        ctx.font = `800 ${17 * u}px ${FONT}`
        ctx.fillText(opts.labels.lines.toUpperCase(), innerL, legendTop + 38 * u)

        const cols = Math.max(1, Math.floor((W - 2 * m - 88 * u) / (380 * u)))
        const colW = (innerR - innerL) / cols
        mainLines.forEach((line, i) => {
            const cx = innerL + (i % cols) * colW
            const cy = legendTop + 72 * u + Math.floor(i / cols) * 50 * u
            drawBadge(ctx, line, cx + 17 * u, cy, 17 * u, u)
            ctx.fillStyle = INK
            ctx.font = `700 ${19 * u}px ${FONT}`
            ctx.fillText(ellipsize(ctx, line.name, colW - 60 * u), cx + 44 * u, cy - 2 * u)
            // statistics always come from the real network
            const real = source.lines.find(l => l.id === line.id) ?? line
            const len = M.lineLength(source, real, sourceNodes)
            const stops = M.lineStops(source, real, sourceNodes).length
            ctx.fillStyle = '#6b6b6b'
            ctx.font = `400 ${14 * u}px ${FONT}`
            ctx.fillText(ellipsize(ctx, opts.labels.lineStats(real, stops, len, len / source.settings.trainSpeed), colW - 60 * u), cx + 44 * u, cy + 17 * u)
        })

        // symbol legend
        const sy = H - m - 44 * u
        let sx = innerL
        const symbol = (label: string, draw: (x: number, y: number) => void) => {
            draw(sx + 14 * u, sy)
            ctx.fillStyle = '#444'
            ctx.font = `500 ${15 * u}px ${FONT}`
            ctx.fillText(label, sx + 42 * u, sy + 5 * u)
            sx += 42 * u + ctx.measureText(label).width + 30 * u
        }
        const demoLine: RailLine = mainLines[0] ?? { id: '', name: '', code: '', color: '#e3002b', kind: 'line', nodeIds: [] }
        const fakeInteg = (n: number): M.Integrations => ({ lines: Array(n).fill(demoLine), transferLines: [], transferStations: [], text: '' })
        const demo = (type: RailNode['type']): RailNode => ({ id: '', type, x: 0, z: 0, name: '', integrations: '', notes: '' })
        symbol(opts.labels.station, (x, y) => {
            strokeSeg(ctx, { x1: x - 14 * u, y1: y, x2: x + 14 * u, y2: y }, demoLine.color, lw * 0.8)
            drawStation(ctx, demo('station'), x, y, lw * 0.6, fakeInteg(1), false, lw, u)
        })
        if (mainLines.length > 0) {
            const trackDemo = (double: boolean) => (x: number, y: number) => {
                const s = { x1: x - 14 * u, y1: y, x2: x + 14 * u, y2: y }
                strokeSeg(ctx, s, demoLine.color, lw * 0.8)
                if (double) strokeSeg(ctx, s, 'rgba(255,255,255,0.9)', Math.max(1, lw * 0.18), 'butt')
            }
            symbol(opts.labels.double, trackDemo(true))
            if (project.singleTrack.length > 0) symbol(opts.labels.single, trackDemo(false))
        }
        symbol(opts.labels.interchange, (x, y) => drawStation(ctx, demo('station'), x, y, lw * 0.8, fakeInteg(2), true, lw, u))
        symbol(opts.labels.terminal, (x, y) => drawStation(ctx, demo('terminal'), x, y, lw * 0.9, fakeInteg(1), false, lw, u))
        if (opts.showDepots) symbol(opts.labels.depot, (x, y) => drawStation(ctx, demo('depot'), x, y, lw * 0.9, fakeInteg(0), false, lw, u))
        if (project.transfers.length > 0) symbol(opts.labels.transfer, (x, y) => {
            const s = { x1: x - 14 * u, y1: y, x2: x + 14 * u, y2: y }
            strokeSeg(ctx, s, INK, lw * 0.7 + 6 * u)
            strokeSeg(ctx, s, '#ffffff', lw * 0.7 - 1 * u)
        })
        if (opts.showServiceTracks && lines.some(l => l.kind === 'service')) symbol(opts.labels.service, (x, y) => {
            ctx.setLineDash([lw * 0.9, lw * 0.7])
            strokeSeg(ctx, { x1: x - 14 * u, y1: y, x2: x + 14 * u, y2: y }, '#777', lw * 0.45, 'butt')
            ctx.setLineDash([])
        })
    }

    // ---------- footer ----------
    if (opts.footer) {
        ctx.fillStyle = '#8a8a8a'
        ctx.font = `400 ${13 * u}px ${FONT}`
        ctx.textAlign = 'right'
        ctx.fillText(ellipsize(ctx, opts.footer, (innerR - innerL) * 0.6), innerR, H - m - 14 * u)
        ctx.textAlign = 'left'
    }

    return canvas
}

// =================================================================================

function clamp(v: number, min: number, max: number) {
    return Math.min(max, Math.max(min, v))
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
}

function strokeSeg(ctx: CanvasRenderingContext2D, s: Seg, color: string, width: number, cap: CanvasLineCap = 'round') {
    ctx.beginPath()
    ctx.moveTo(s.x1, s.y1)
    ctx.lineTo(s.x2, s.y2)
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.lineCap = cap
    ctx.stroke()
}

function fitFont(ctx: CanvasRenderingContext2D, text: string, fontTemplate: string, size: number, maxWidth: number) {
    let s = size
    while (s > 12) {
        ctx.font = fontTemplate.replace('{s}', `${s}`)
        if (ctx.measureText(text).width <= maxWidth) break
        s *= 0.92
    }
    return s
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
    if (ctx.measureText(text).width <= maxWidth) return text
    let t = text
    while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1)
    return t + '…'
}

function drawNorthArrow(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(x, y - size)
    ctx.lineTo(x + size * 0.45, y + size * 0.55)
    ctx.lineTo(x, y + size * 0.25)
    ctx.lineTo(x - size * 0.45, y + size * 0.55)
    ctx.closePath()
    ctx.fillStyle = INK
    ctx.fill()
    ctx.font = `800 ${size * 0.6}px ${FONT}`
    ctx.textAlign = 'center'
    ctx.fillText('N', x, y - size * 1.15)
    ctx.restore()
}

function drawBadge(ctx: CanvasRenderingContext2D, line: RailLine, x: number, y: number, r: number, u: number) {
    ctx.font = `800 ${r * 1.0}px ${FONT}`
    const text = line.code || '•'
    const tw = ctx.measureText(text).width
    const w = Math.max(2 * r, tw + r)
    ctx.beginPath()
    if (w > 2 * r) {
        roundRect(ctx, x - w / 2, y - r, w, 2 * r, r)
    } else {
        ctx.arc(x, y, r, 0, Math.PI * 2)
    }
    ctx.fillStyle = line.color
    ctx.fill()
    ctx.fillStyle = readableText(line.color)
    ctx.textAlign = 'center'
    ctx.fillText(text, x, y + r * 0.36)
    ctx.textAlign = 'left'
    return w
}

function readableText(hex: string) {
    const v = parseInt(hex.slice(1), 16)
    const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255
    return (0.299 * r + 0.587 * g + 0.114 * b) > 170 ? INK : '#ffffff'
}

function drawStation(ctx: CanvasRenderingContext2D, node: RailNode, x: number, y: number, r: number, integ: M.Integrations, interchange: boolean, lw: number, u: number) {
    ctx.save()
    if (node.type === 'depot') {
        const s = r * 1.7
        roundRect(ctx, x - s / 2, y - s / 2, s, s, 4 * u)
        ctx.fillStyle = '#37474f'
        ctx.fill()
        ctx.lineWidth = 2.5 * u
        ctx.strokeStyle = '#ffffff'
        ctx.stroke()
        ctx.fillStyle = '#ffffff'
        ctx.font = `800 ${s * 0.62}px ${FONT}`
        ctx.textAlign = 'center'
        ctx.fillText('D', x, y + s * 0.22)
        ctx.restore()
        return
    }
    const color = integ.lines[0]?.color ?? '#777777'
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    if (node.type === 'terminal') {
        ctx.lineWidth = 5.5 * u
        ctx.strokeStyle = INK
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(x, y, r * 0.42, 0, Math.PI * 2)
        ctx.fillStyle = interchange ? INK : color
        ctx.fill()
    } else if (interchange) {
        ctx.lineWidth = 4.5 * u
        ctx.strokeStyle = INK
        ctx.stroke()
    } else {
        ctx.lineWidth = lw * 0.42
        ctx.strokeStyle = color
        ctx.stroke()
    }
    ctx.restore()
}

type LabelBlock = { w: number, h: number, nameSize: number, nameFont: string, badges: RailLine[], badgeR: number, text: string, textFont: string, textSize: number }

function measureLabel(ctx: CanvasRenderingContext2D, p: { node: RailNode, integ: M.Integrations, interchange: boolean }, opts: PosterOptions, u: number): LabelBlock {
    const t = p.node.type
    const nameSize = (t === 'terminal' ? 24 : p.interchange ? 21 : t === 'depot' ? 16 : 18) * u
    const weight = t === 'terminal' || p.interchange ? 800 : t === 'depot' ? 500 : 650
    const nameFont = `${t === 'depot' ? 'italic ' : ''}${weight} ${nameSize}px ${FONT}`
    ctx.font = nameFont
    let w = p.node.name ? ctx.measureText(p.node.name).width : 0
    let h = p.node.name ? nameSize : 0

    const badges = opts.showIntegrations && p.interchange ? [...p.integ.lines, ...p.integ.transferLines] : []
    const badgeR = 10 * u
    if (badges.length > 0) {
        ctx.font = `800 ${badgeR}px ${FONT}`
        const bw = badges.reduce((acc, l) => acc + Math.max(2 * badgeR, ctx.measureText(l.code || '•').width + badgeR) + 4 * u, -4 * u)
        w = Math.max(w, bw)
        h += 6 * u + 2 * badgeR
    }
    const textSize = 14 * u
    const textFont = `italic 500 ${textSize}px ${FONT}`
    const text = opts.showIntegrations && p.integ.text ? `⇄ ${p.integ.text}` : ''
    if (text) {
        ctx.font = textFont
        w = Math.max(w, ctx.measureText(text).width)
        h += 5 * u + textSize
    }
    return { w, h, nameSize, nameFont, badges, badgeR, text, textFont, textSize }
}

type Align = 'left' | 'right' | 'center'

function labelCandidates(x: number, y: number, d: number, w: number, h: number): { rect: Rect, align: Align }[] {
    const diag = d * 0.75
    return [
        { rect: { x: x + d, y: y - h / 2, w, h }, align: 'left' },                 // E
        { rect: { x: x - d - w, y: y - h / 2, w, h }, align: 'right' },            // W
        { rect: { x: x + diag, y: y - diag - h, w, h }, align: 'left' },           // NE
        { rect: { x: x + diag, y: y + diag, w, h }, align: 'left' },               // SE
        { rect: { x: x - diag - w, y: y - diag - h, w, h }, align: 'right' },      // NW
        { rect: { x: x - diag - w, y: y + diag, w, h }, align: 'right' },          // SW
        { rect: { x: x - w / 2, y: y - d - h, w, h }, align: 'center' },           // N
        { rect: { x: x - w / 2, y: y + d, w, h }, align: 'center' },               // S
    ]
}

function drawLabel(ctx: CanvasRenderingContext2D, p: { node: RailNode }, b: LabelBlock, rect: Rect, align: Align, opts: PosterOptions, u: number) {
    const ax = align === 'left' ? rect.x : align === 'right' ? rect.x + rect.w : rect.x + rect.w / 2
    let y = rect.y
    ctx.save()
    ctx.textAlign = align
    ctx.lineJoin = 'round'
    if (p.node.name) {
        ctx.font = b.nameFont
        y += b.nameSize * 0.85
        ctx.lineWidth = 5 * u
        ctx.strokeStyle = 'rgba(255,255,255,0.92)'
        ctx.strokeText(p.node.name, ax, y)
        ctx.fillStyle = p.node.type === 'depot' ? '#455a64' : INK
        ctx.fillText(p.node.name, ax, y)
        y += b.nameSize * 0.15
    }
    if (b.badges.length > 0) {
        y += 6 * u + b.badgeR
        ctx.font = `800 ${b.badgeR}px ${FONT}`
        const widths = b.badges.map(l => Math.max(2 * b.badgeR, ctx.measureText(l.code || '•').width + b.badgeR))
        const total = widths.reduce((a, c) => a + c + 4 * u, -4 * u)
        let x = align === 'left' ? rect.x : align === 'right' ? rect.x + rect.w - total : rect.x + (rect.w - total) / 2
        b.badges.forEach((line, i) => {
            drawBadge(ctx, line, x + widths[i] / 2, y, b.badgeR, u)
            x += widths[i] + 4 * u
        })
        ctx.textAlign = align
        y += b.badgeR
    }
    if (b.text) {
        ctx.font = b.textFont
        y += 5 * u + b.textSize * 0.85
        ctx.lineWidth = 4 * u
        ctx.strokeStyle = 'rgba(255,255,255,0.92)'
        ctx.strokeText(b.text, ax, y)
        ctx.fillStyle = '#555555'
        ctx.fillText(b.text, ax, y)
    }
    ctx.restore()
}

function drawScaleBar(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, u: number, unit: string) {
    const target = 170 * u / k
    const pow = Math.pow(10, Math.floor(Math.log10(target)))
    const nice = [1, 2, 5, 10].map(f => f * pow).reverse().find(v => v <= target) ?? pow
    const len = nice * k
    ctx.save()
    ctx.fillStyle = INK
    ctx.fillRect(x, y - 4 * u, len / 2, 6 * u)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(x + len / 2, y - 4 * u, len / 2, 6 * u)
    ctx.strokeStyle = INK
    ctx.lineWidth = 1.5 * u
    ctx.strokeRect(x, y - 4 * u, len, 6 * u)
    ctx.fillStyle = INK
    ctx.font = `600 ${13 * u}px ${FONT}`
    ctx.fillText(`0`, x - 3 * u, y - 10 * u)
    ctx.textAlign = 'right'
    ctx.fillText(`${M.formatBlocks(nice)} ${unit}`, x + len + 3 * u, y - 10 * u)
    ctx.restore()
}

function intersects(a: Rect, b: Rect) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function contains(outer: Rect, inner: Rect) {
    return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
}

function inflate(r: Rect, d: number): Rect {
    return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d }
}

/** Liang–Barsky clipping test */
function segIntersectsRect(s: Seg, r: Rect) {
    let t0 = 0, t1 = 1
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1
    const p = [-dx, dx, -dy, dy]
    const q = [s.x1 - r.x, r.x + r.w - s.x1, s.y1 - r.y, r.y + r.h - s.y1]
    for (let i = 0; i < 4; i++) {
        if (p[i] === 0) {
            if (q[i] < 0) return false
        } else {
            const t = q[i] / p[i]
            if (p[i] < 0) t0 = Math.max(t0, t)
            else t1 = Math.min(t1, t)
            if (t0 > t1) return false
        }
    }
    return true
}
