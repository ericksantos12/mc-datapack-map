import type { LineKind, NodeType, TrackType, ProjectSummary, RailLine, RailNode, RailProject, RailTransfer, WorldSettings } from "./types.js"

export const PROJECT_FORMAT = 1

/** Metro-style palette, picked to stay distinguishable on biome colors and on white. */
export const LINE_COLORS = [
    '#e3002b', '#0070c0', '#00a651', '#f7a800', '#8e44ad', '#ff6f00',
    '#00a3c4', '#d6006f', '#6d4c41', '#7cb342', '#283593', '#9e9e9e',
]

export function uid(prefix = ''): string {
    const random = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
        : Math.random().toString(36).slice(2, 14)
    return prefix + random
}

export function createProject(world: WorldSettings, title: string): RailProject {
    const now = Date.now()
    return {
        format: PROJECT_FORMAT,
        id: uid('p_'),
        title,
        subtitle: '',
        createdAt: now,
        updatedAt: now,
        world: { ...world, datapacks: [...world.datapacks] },
        settings: { trainSpeed: 8, newTrack: 'double' },
        singleTrack: [],
        nodes: [],
        lines: [],
        transfers: [],
    }
}

export function summarize(p: RailProject): ProjectSummary {
    return {
        id: p.id,
        title: p.title,
        updatedAt: p.updatedAt,
        seed: p.world.seed,
        stations: p.nodes.filter(n => n.type !== 'waypoint').length,
        lines: p.lines.length,
    }
}

export function isEmptyProject(p: RailProject) {
    return p.nodes.length === 0 && p.lines.length === 0
}

// ===================== validation (for imported / stored data) =====================

const NODE_TYPES: NodeType[] = ['station', 'terminal', 'depot', 'waypoint']
const LINE_KINDS: LineKind[] = ['line', 'service']
const MAX_TEXT = 200
const MAX_ITEMS = 5000
const MAX_COORD = 30_000_000
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function coord(v: unknown) {
    return Math.max(-MAX_COORD, Math.min(MAX_COORD, Math.round(num(v))))
}

function str(v: unknown, fallback = '', max = MAX_TEXT): string {
    return typeof v === 'string' ? v.slice(0, max) : fallback
}

function num(v: unknown, fallback = 0): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function color(v: unknown, fallback: string): string {
    return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback
}

function arr(v: unknown): unknown[] {
    return Array.isArray(v) ? v.slice(0, MAX_ITEMS) : []
}

/**
 * Turns untrusted JSON into a well-formed project. Throws if it is clearly not a railroad project.
 */
export function sanitizeProject(raw: unknown): RailProject {
    if (typeof raw !== 'object' || raw === null) throw new Error('Not a project file')
    const r = raw as Record<string, any>
    if (!Array.isArray(r.nodes) || !Array.isArray(r.lines)) throw new Error('Not a railroad project file')

    const world = (typeof r.world === 'object' && r.world !== null) ? r.world : {}

    const nodes: RailNode[] = []
    const nodeIds = new Set<string>()
    for (const n of arr(r.nodes) as any[]) {
        if (typeof n !== 'object' || n === null) continue
        const id = str(n.id, '', 64)
        if (!ID_PATTERN.test(id) || nodeIds.has(id)) continue
        nodeIds.add(id)
        nodes.push({
            id,
            type: NODE_TYPES.includes(n.type) ? n.type : 'station',
            x: coord(n.x),
            z: coord(n.z),
            name: str(n.name),
            integrations: str(n.integrations),
            notes: str(n.notes, '', 2000),
        })
    }

    const lines: RailLine[] = []
    const lineIds = new Set<string>()
    for (const [i, l] of (arr(r.lines) as any[]).entries()) {
        if (typeof l !== 'object' || l === null) continue
        const id = str(l.id, '', 64)
        if (!ID_PATTERN.test(id) || lineIds.has(id)) continue
        lineIds.add(id)
        const path = dedupeConsecutive(arr(l.nodeIds).filter((nid): nid is string => typeof nid === 'string' && nodeIds.has(nid)))
        lines.push({
            id,
            name: str(l.name, `Line ${i + 1}`),
            code: str(l.code, `${i + 1}`, 4),
            color: color(l.color, LINE_COLORS[i % LINE_COLORS.length]),
            kind: LINE_KINDS.includes(l.kind) ? l.kind : 'line',
            nodeIds: path,
        })
    }

    const transfers: RailTransfer[] = []
    const transferKeys = new Set<string>()
    for (const t of arr(r.transfers) as any[]) {
        if (typeof t !== 'object' || t === null) continue
        const a = str(t.a, '', 64), b = str(t.b, '', 64)
        if (!nodeIds.has(a) || !nodeIds.has(b) || a === b) continue
        const key = segmentKey(a, b)
        if (transferKeys.has(key)) continue
        transferKeys.add(key)
        const tid = str(t.id, '', 64)
        transfers.push({ id: ID_PATTERN.test(tid) && !transfers.some(x => x.id === tid) ? tid : uid('t_'), a, b })
    }

    const now = Date.now()
    const project: RailProject = {
        format: PROJECT_FORMAT,
        id: ID_PATTERN.test(str(r.id, '', 64)) ? str(r.id, '', 64) : uid('p_'),
        title: str(r.title, 'Railroad'),
        subtitle: str(r.subtitle),
        createdAt: num(r.createdAt, now),
        updatedAt: num(r.updatedAt, now),
        world: {
            seed: typeof world.seed === 'number' || typeof world.seed === 'bigint' ? String(world.seed) : str(world.seed, '0', 64),
            mc_version: str(world.mc_version, '', 16),
            world_preset: str(world.world_preset, 'minecraft:normal', 128),
            dimension: str(world.dimension, 'minecraft:overworld', 128),
            datapacks: arr(world.datapacks).filter((d): d is string => typeof d === 'string').map(d => d.slice(0, 200)).slice(0, 50),
        },
        settings: {
            trainSpeed: Math.min(100, Math.max(0.5, num(r.settings?.trainSpeed, 8))),
            newTrack: r.settings?.newTrack === 'single' ? 'single' : 'double',
        },
        singleTrack: [],
        nodes,
        lines,
        transfers,
    }
    const usage = segmentUsage(project)
    project.singleTrack = [...new Set(arr(r.singleTrack).filter((k): k is string => typeof k === 'string' && usage.has(k)))]
    return project
}

// ===================== queries =====================

export function nodeMap(p: RailProject): Map<string, RailNode> {
    return new Map(p.nodes.map(n => [n.id, n]))
}

export function linesAtNode(p: RailProject, nodeId: string): RailLine[] {
    return p.lines.filter(l => l.nodeIds.includes(nodeId))
}

export function transfersAtNode(p: RailProject, nodeId: string): RailTransfer[] {
    return p.transfers.filter(t => t.a === nodeId || t.b === nodeId)
}

export type Integrations = {
    /** lines stopping at this node */
    lines: RailLine[]
    /** lines reachable through a transfer link (not stopping here) */
    transferLines: RailLine[]
    /** stations connected through transfer links */
    transferStations: RailNode[]
    /** free text integrations */
    text: string
}

export function integrationsOf(p: RailProject, nodeId: string, nodes = nodeMap(p)): Integrations {
    const lines = linesAtNode(p, nodeId).filter(l => l.kind === 'line')
    const own = new Set(lines.map(l => l.id))
    const transferStations: RailNode[] = []
    const transferLines: RailLine[] = []
    for (const t of transfersAtNode(p, nodeId)) {
        const other = nodes.get(t.a === nodeId ? t.b : t.a)
        if (!other) continue
        transferStations.push(other)
        for (const l of linesAtNode(p, other.id)) {
            if (l.kind === 'line' && !own.has(l.id)) {
                own.add(l.id)
                transferLines.push(l)
            }
        }
    }
    return { lines, transferLines, transferStations, text: nodes.get(nodeId)?.integrations ?? '' }
}

export function isInterchange(i: Integrations) {
    return i.lines.length + i.transferLines.length >= 2
}

export function lineLength(p: RailProject, line: RailLine, nodes = nodeMap(p)): number {
    let total = 0
    for (let i = 1; i < line.nodeIds.length; i++) {
        const a = nodes.get(line.nodeIds[i - 1]), b = nodes.get(line.nodeIds[i])
        if (a && b) total += Math.hypot(a.x - b.x, a.z - b.z)
    }
    return total
}

export function lineStops(p: RailProject, line: RailLine, nodes = nodeMap(p)): RailNode[] {
    return line.nodeIds.map(id => nodes.get(id)).filter((n): n is RailNode => n !== undefined && n.type !== 'waypoint')
}

export function networkLength(p: RailProject, nodes = nodeMap(p)): number {
    // shared segments are counted once
    const seen = new Set<string>()
    let total = 0
    for (const line of p.lines) {
        for (let i = 1; i < line.nodeIds.length; i++) {
            const key = segmentKey(line.nodeIds[i - 1], line.nodeIds[i])
            if (seen.has(key)) continue
            seen.add(key)
            const a = nodes.get(line.nodeIds[i - 1]), b = nodes.get(line.nodeIds[i])
            if (a && b) total += Math.hypot(a.x - b.x, a.z - b.z)
        }
    }
    return total
}

export function segmentKey(a: string, b: string) {
    return a < b ? `${a}|${b}` : `${b}|${a}`
}

/**
 * For every segment (unordered node pair) the ordered list of lines using it.
 * Used to draw parallel lines side by side, metro style.
 */
export function segmentUsage(p: RailProject): Map<string, string[]> {
    const usage = new Map<string, string[]>()
    for (const line of p.lines) {
        for (let i = 1; i < line.nodeIds.length; i++) {
            const key = segmentKey(line.nodeIds[i - 1], line.nodeIds[i])
            const list = usage.get(key) ?? []
            if (!list.includes(line.id)) list.push(line.id)
            usage.set(key, list)
        }
    }
    return usage
}

/** Offset (in "lane" units, centered on 0) of a line on a segment, relative to the canonical a<b direction */
export function laneOffset(usage: Map<string, string[]>, a: string, b: string, lineId: string): number {
    const list = usage.get(segmentKey(a, b))
    if (!list || list.length <= 1) return 0
    return list.indexOf(lineId) - (list.length - 1) / 2
}

export function bounds(nodes: { x: number, z: number }[]) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    for (const n of nodes) {
        minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x)
        minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z)
    }
    return { minX, minZ, maxX, maxZ }
}

// ===================== geometry =====================

/** Snaps `to` so that the direction from `from` is a multiple of 45° (octilinear, metro style). */
export function snapOctilinear(from: { x: number, z: number }, to: { x: number, z: number }) {
    const dx = to.x - from.x, dz = to.z - from.z
    const len = Math.hypot(dx, dz)
    if (len === 0) return { x: to.x, z: to.z }
    const angle = Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) * (Math.PI / 4)
    // project onto the snapped direction
    const proj = dx * Math.cos(angle) + dz * Math.sin(angle)
    return {
        x: Math.round(from.x + Math.cos(angle) * proj),
        z: Math.round(from.z + Math.sin(angle) * proj),
    }
}

export function projectOnSegment(p: { x: number, y: number }, a: { x: number, y: number }, b: { x: number, y: number }) {
    const dx = b.x - a.x, dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    const x = a.x + dx * t, y = a.y + dy * t
    return { t, x, y, dist: Math.hypot(p.x - x, p.y - y) }
}

// ===================== mutations (operate in place) =====================

function dedupeConsecutive(ids: string[]): string[] {
    return ids.filter((id, i) => i === 0 || ids[i - 1] !== id)
}

export function addNode(p: RailProject, type: NodeType, x: number, z: number, name = ''): RailNode {
    const node: RailNode = { id: uid('n_'), type, x: Math.round(x), z: Math.round(z), name, integrations: '', notes: '' }
    p.nodes.push(node)
    return node
}

export function addLine(p: RailProject, name: string): RailLine {
    const used = new Set(p.lines.map(l => l.color))
    const color = LINE_COLORS.find(c => !used.has(c)) ?? LINE_COLORS[p.lines.length % LINE_COLORS.length]
    const usedCodes = new Set(p.lines.map(l => l.code))
    let n = 1
    while (usedCodes.has(`${n}`)) n++
    const line: RailLine = { id: uid('l_'), name: name.replace('{n}', `${n}`), code: `${n}`, color, kind: 'line', nodeIds: [] }
    p.lines.push(line)
    return line
}

/** Removes nodes of type waypoint that are no longer used by any line. */
export function pruneOrphanWaypoints(p: RailProject) {
    const used = new Set(p.lines.flatMap(l => l.nodeIds))
    p.nodes = p.nodes.filter(n => n.type !== 'waypoint' || used.has(n.id))
}

export function cleanupLines(p: RailProject, keepLineId?: string) {
    for (const l of p.lines) {
        l.nodeIds = dedupeConsecutive(l.nodeIds)
    }
    p.lines = p.lines.filter(l => l.id === keepLineId || l.nodeIds.length >= 2)
    pruneTrackTypes(p)
}

// ===================== single / double track =====================

export function trackType(p: RailProject, a: string, b: string): TrackType {
    return p.singleTrack.includes(segmentKey(a, b)) ? 'single' : 'double'
}

export function setTrackType(p: RailProject, a: string, b: string, type: TrackType) {
    const key = segmentKey(a, b)
    const has = p.singleTrack.includes(key)
    if (type === 'single' && !has) p.singleTrack.push(key)
    if (type === 'double' && has) p.singleTrack = p.singleTrack.filter(k => k !== key)
}

export function setLineTrackType(p: RailProject, line: RailLine, type: TrackType) {
    for (let i = 1; i < line.nodeIds.length; i++) setTrackType(p, line.nodeIds[i - 1], line.nodeIds[i], type)
}

/** Drops single-track markers of sections that no longer exist */
export function pruneTrackTypes(p: RailProject) {
    const usage = segmentUsage(p)
    p.singleTrack = [...new Set(p.singleTrack)].filter(k => usage.has(k))
}

/** Lengths of single and double track (shared sections counted once) and the number of rails needed */
export function trackStats(p: RailProject, lines: RailLine[] = p.lines, nodes = nodeMap(p)) {
    const seen = new Set<string>()
    let single = 0, double = 0
    for (const line of lines) {
        for (let i = 1; i < line.nodeIds.length; i++) {
            const key = segmentKey(line.nodeIds[i - 1], line.nodeIds[i])
            if (seen.has(key)) continue
            seen.add(key)
            const a = nodes.get(line.nodeIds[i - 1]), b = nodes.get(line.nodeIds[i])
            if (!a || !b) continue
            const len = Math.hypot(a.x - b.x, a.z - b.z)
            if (p.singleTrack.includes(key)) single += len
            else double += len
        }
    }
    return { single, double, rails: single + 2 * double }
}

export function deleteNode(p: RailProject, nodeId: string) {
    // the track that replaces prev-node-next stays single track if one of the two pieces was
    for (const l of p.lines) {
        l.nodeIds.forEach((id, i) => {
            if (id !== nodeId || i === 0 || i === l.nodeIds.length - 1) return
            const prev = l.nodeIds[i - 1], next = l.nodeIds[i + 1]
            if (trackType(p, prev, id) === 'single' || trackType(p, id, next) === 'single') setTrackType(p, prev, next, 'single')
        })
    }
    for (const l of p.lines) {
        l.nodeIds = l.nodeIds.filter(id => id !== nodeId)
    }
    p.transfers = p.transfers.filter(t => t.a !== nodeId && t.b !== nodeId)
    p.nodes = p.nodes.filter(n => n.id !== nodeId)
    cleanupLines(p)
    pruneOrphanWaypoints(p)
}

export function deleteLine(p: RailProject, lineId: string) {
    p.lines = p.lines.filter(l => l.id !== lineId)
    pruneOrphanWaypoints(p)
    pruneTrackTypes(p)
}

/** Inserts `nodeId` between a and b in every line that uses the segment a-b. Returns number of lines changed. */
export function insertIntoSegment(p: RailProject, a: string, b: string, nodeId: string): number {
    if (trackType(p, a, b) === 'single') {
        setTrackType(p, a, nodeId, 'single')
        setTrackType(p, nodeId, b, 'single')
    }
    let count = 0
    for (const l of p.lines) {
        for (let i = 1; i < l.nodeIds.length; i++) {
            const prev = l.nodeIds[i - 1], cur = l.nodeIds[i]
            if ((prev === a && cur === b) || (prev === b && cur === a)) {
                l.nodeIds.splice(i, 0, nodeId)
                count++
                i++
            }
        }
    }
    return count
}

/** Merges node `removeId` into `keepId`: every reference is redirected. */
export function mergeNodes(p: RailProject, keepId: string, removeId: string) {
    if (keepId === removeId) return
    for (const l of p.lines) {
        l.nodeIds = l.nodeIds.map(id => id === removeId ? keepId : id)
    }
    p.singleTrack = p.singleTrack.map(key => {
        const [a, b] = key.split('|').map(id => id === removeId ? keepId : id)
        return segmentKey(a, b)
    })
    for (const t of p.transfers) {
        if (t.a === removeId) t.a = keepId
        if (t.b === removeId) t.b = keepId
    }
    const seen = new Set<string>()
    p.transfers = p.transfers.filter(t => {
        const key = segmentKey(t.a, t.b)
        if (t.a === t.b || seen.has(key)) return false
        seen.add(key)
        return true
    })
    p.nodes = p.nodes.filter(n => n.id !== removeId)
    cleanupLines(p)
    pruneOrphanWaypoints(p)
}

export function addTransfer(p: RailProject, a: string, b: string): RailTransfer | undefined {
    if (a === b) return undefined
    if (p.transfers.some(t => (t.a === a && t.b === b) || (t.a === b && t.b === a))) return undefined
    const t = { id: uid('t_'), a, b }
    p.transfers.push(t)
    return t
}

// ===================== formatting =====================

export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds)) return '–'
    const s = Math.round(seconds)
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

export function formatBlocks(blocks: number): string {
    return Math.round(blocks).toLocaleString()
}

export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

export function safeFileName(name: string): string {
    return (name.trim() || 'railroad').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 80)
}
