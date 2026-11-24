import * as M from "./model.js"
import type { RailLine, RailNode, RailProject } from "./types.js"

/**
 * Turns the geographic network into a metro-map style schematic:
 *  - track points (waypoints) that are not junctions are removed, lines only keep their stops and junctions
 *  - every connection is pulled towards the nearest 0° / 45° / 90° direction
 *  - stations are spaced (almost) evenly, long connections only get slightly longer
 *  - the rough geography (what is north / east of what) is kept with a weak anchor
 *  - connections that still are not octilinear get a 45° elbow
 *
 * The result is a new project whose coordinates are in abstract units (one station spacing ≈ UNIT).
 * Node, line and transfer ids are preserved, so integrations still work on it.
 */

export const UNIT = 100

type Edge = { a: string, b: string, real: number, dir: { x: number, z: number }, target: number, single?: boolean }

const ANGLES = Array.from({ length: 8 }, (_, i) => i * Math.PI / 4)

function snapDirection(dx: number, dz: number) {
    if (dx === 0 && dz === 0) return { x: 1, z: 0 }
    const angle = (Math.atan2(dz, dx) + 2 * Math.PI) % (2 * Math.PI)
    let best = ANGLES[0], bestDiff = Infinity
    for (const a of ANGLES) {
        let diff = Math.abs(angle - a)
        diff = Math.min(diff, 2 * Math.PI - diff)
        if (diff < bestDiff) { bestDiff = diff; best = a }
    }
    return { x: Math.cos(best), z: Math.sin(best) }
}

export function schematize(project: RailProject, lines: RailLine[]): RailProject {
    const nodes = M.nodeMap(project)

    // ---------- 1. key nodes ----------
    const neighbors = new Map<string, Set<string>>()
    const segLines = new Map<string, Set<string>>()
    const endpoints = new Set<string>()
    for (const line of lines) {
        const ids = line.nodeIds
        endpoints.add(ids[0])
        endpoints.add(ids[ids.length - 1])
        for (let i = 1; i < ids.length; i++) {
            const a = ids[i - 1], b = ids[i]
            if (!neighbors.has(a)) neighbors.set(a, new Set())
            if (!neighbors.has(b)) neighbors.set(b, new Set())
            neighbors.get(a)!.add(b)
            neighbors.get(b)!.add(a)
            const key = M.segmentKey(a, b)
            if (!segLines.has(key)) segLines.set(key, new Set())
            segLines.get(key)!.add(line.id)
        }
    }
    const isKey = (id: string) => {
        const node = nodes.get(id)
        if (!node) return false
        if (node.type !== 'waypoint' || endpoints.has(id)) return true
        const nb = [...(neighbors.get(id) ?? [])]
        if (nb.length !== 2) return true
        const l1 = [...(segLines.get(M.segmentKey(id, nb[0])) ?? [])].sort().join()
        const l2 = [...(segLines.get(M.segmentKey(id, nb[1])) ?? [])].sort().join()
        return l1 !== l2
    }

    const keyIds = new Set<string>()
    for (const n of project.nodes) {
        if (n.type !== 'waypoint' || isKey(n.id)) keyIds.add(n.id)
    }

    // ---------- 2. reduced lines and edges ----------
    const edges = new Map<string, Edge>()
    const reducedLines: RailLine[] = []
    for (const line of lines) {
        const chain: string[] = []
        let real = 0
        let singleLen = 0
        for (let i = 0; i < line.nodeIds.length; i++) {
            const id = line.nodeIds[i]
            if (i > 0) {
                const p = nodes.get(line.nodeIds[i - 1])!, c = nodes.get(id)!
                const len = Math.hypot(p.x - c.x, p.z - c.z)
                real += len
                if (M.trackType(project, line.nodeIds[i - 1], id) === 'single') singleLen += len
            }
            if (!keyIds.has(id)) continue
            if (chain.length > 0) {
                const prev = chain[chain.length - 1]
                if (prev !== id) {
                    const key = M.segmentKey(prev, id)
                    const existing = edges.get(key)
                    if (!existing || existing.real > real) {
                        const [a, b] = prev < id ? [prev, id] : [id, prev]
                        const na = nodes.get(a)!, nb = nodes.get(b)!
                        edges.set(key, {
                            a, b, real: Math.hypot(nb.x - na.x, nb.z - na.z), dir: snapDirection(nb.x - na.x, nb.z - na.z), target: UNIT,
                            // the simplified connection is single track if most of the real track is
                            single: singleLen > real / 2,
                        })
                    }
                }
            }
            if (chain[chain.length - 1] !== id) chain.push(id)
            real = 0
            singleLen = 0
        }
        reducedLines.push({ ...line, nodeIds: chain })
    }
    for (const t of project.transfers) {
        if (!keyIds.has(t.a) || !keyIds.has(t.b)) continue
        const key = M.segmentKey(t.a, t.b)
        if (edges.has(key)) continue
        const [a, b] = t.a < t.b ? [t.a, t.b] : [t.b, t.a]
        const na = nodes.get(a)!, nb = nodes.get(b)!
        const real = Math.hypot(nb.x - na.x, nb.z - na.z)
        edges.set(key, { a, b, real, dir: snapDirection(nb.x - na.x, nb.z - na.z), target: UNIT * 0.6 })
    }

    const edgeList = [...edges.values()]
    const ids = [...keyIds]
    if (ids.length === 0) return project

    // target lengths: mostly uniform, long connections slightly longer
    const reals = edgeList.map(e => e.real).filter(r => r > 0).sort((a, b) => a - b)
    const median = reals.length > 0 ? reals[Math.floor(reals.length / 2)] : 1
    for (const e of edgeList) {
        if (e.target === UNIT) e.target = UNIT * Math.min(2.5, Math.max(0.75, Math.pow(Math.max(e.real, 1) / median, 0.5)))
    }

    // ---------- 3. initial positions: geography scaled so the median connection is one UNIT ----------
    const scale = UNIT / Math.max(median, 1)
    const anchor = new Map<string, { x: number, z: number }>()
    const pos = new Map<string, { x: number, z: number }>()
    for (const id of ids) {
        const n = nodes.get(id)!
        anchor.set(id, { x: n.x * scale, z: n.z * scale })
        pos.set(id, { x: n.x * scale, z: n.z * scale })
    }
    const incident = new Map<string, Edge[]>(ids.map(id => [id, []]))
    for (const e of edgeList) {
        incident.get(e.a)!.push(e)
        incident.get(e.b)!.push(e)
    }

    // ---------- 4. least squares relaxation with repulsion ----------
    const ANCHOR_WEIGHT = 0.12
    const MIN_DIST = UNIT * 0.75
    const adjacent = (a: string, b: string) => edges.has(M.segmentKey(a, b))
    // directions stay the snapped geographic ones: re-snapping an intermediate layout locks in its errors
    {
        for (let iter = 0; iter < 600; iter++) {
            for (const id of ids) {
                const a = anchor.get(id)!
                let sx = a.x * ANCHOR_WEIGHT, sz = a.z * ANCHOR_WEIGHT, w = ANCHOR_WEIGHT
                for (const e of incident.get(id)!) {
                    const sign = e.a === id ? -1 : 1 // a ≈ b - t, b ≈ a + t
                    const other = pos.get(e.a === id ? e.b : e.a)!
                    sx += other.x + sign * e.dir.x * e.target
                    sz += other.z + sign * e.dir.z * e.target
                    w += 1
                }
                pos.set(id, { x: sx / w, z: sz / w })
            }
            if (iter % 10 === 9 && ids.length <= 1500) repel(ids, pos, MIN_DIST, adjacent)
        }
    }
    repel(ids, pos, MIN_DIST, adjacent)

    // ---------- 5. grid snap ----------
    const grid = UNIT / 4
    const taken = new Set<string>()
    for (const id of ids) {
        const p = pos.get(id)!
        let gx = Math.round(p.x / grid), gz = Math.round(p.z / grid)
        while (taken.has(`${gx},${gz}`)) gx++
        taken.add(`${gx},${gz}`)
        pos.set(id, { x: gx * grid, z: gz * grid })
    }

    // ---------- 6. build the schematic project (with 45° elbows) ----------
    const outNodes: RailNode[] = ids.map(id => ({ ...nodes.get(id)!, ...pos.get(id)! }))
    const bends = new Map<string, string | null>()
    const bendFor = (a: string, b: string): string | null => {
        const key = M.segmentKey(a, b)
        if (bends.has(key)) return bends.get(key)!
        const [p, q] = a < b ? [pos.get(a)!, pos.get(b)!] : [pos.get(b)!, pos.get(a)!]
        const dx = q.x - p.x, dz = q.z - p.z
        const adx = Math.abs(dx), adz = Math.abs(dz)
        const eps = 1e-6
        let bend: string | null = null
        if (adx > eps && adz > eps && Math.abs(adx - adz) > eps) {
            const m = Math.min(adx, adz)
            const half = { x: p.x + Math.sign(dx) * m, z: p.z + Math.sign(dz) * m }
            const id = `bend_${key.replace('|', '_')}`
            outNodes.push({ id, type: 'waypoint', x: half.x, z: half.z, name: '', integrations: '', notes: '' })
            bend = id
        }
        bends.set(key, bend)
        return bend
    }
    const outLines = reducedLines.map(line => {
        const out: string[] = []
        line.nodeIds.forEach((id, i) => {
            if (i > 0) {
                const bend = bendFor(line.nodeIds[i - 1], id)
                if (bend) out.push(bend)
            }
            out.push(id)
        })
        return { ...line, nodeIds: out }
    })

    const singleTrack: string[] = []
    for (const e of edgeList) {
        if (!e.single) continue
        const bend = bends.get(M.segmentKey(e.a, e.b))
        if (bend) singleTrack.push(M.segmentKey(e.a, bend), M.segmentKey(bend, e.b))
        else singleTrack.push(M.segmentKey(e.a, e.b))
    }

    return { ...project, nodes: outNodes, lines: outLines, singleTrack }
}

function repel(ids: string[], pos: Map<string, { x: number, z: number }>, minDist: number, adjacent: (a: string, b: string) => boolean) {
    for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
            const a = pos.get(ids[i])!, b = pos.get(ids[j])!
            let dx = b.x - a.x, dz = b.z - a.z
            let d = Math.hypot(dx, dz)
            const limit = adjacent(ids[i], ids[j]) ? minDist * 0.5 : minDist
            if (d >= limit) continue
            if (d < 1e-6) { dx = 1; dz = 0; d = 1 }
            const push = (limit - d) / 2
            a.x -= dx / d * push; a.z -= dz / d * push
            b.x += dx / d * push; b.z += dz / d * push
        }
    }
}
