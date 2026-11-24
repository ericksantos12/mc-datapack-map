import * as L from "leaflet"
import { watch } from "vue"
import { useRailroadStore } from "../stores/useRailroadStore.js"
import * as M from "./model.js"
import type { NodeType, RailLine, RailNode, RailProject } from "./types.js"

const LINE_WEIGHT = 6
const LANE_SPACING = 7
const NODE_HIT_RADIUS = 11
const SEGMENT_HIT_RADIUS = 7

type SegmentHit = { lineIds: string[], a: string, b: string, point: L.Point }

/**
 * Draws the railroad network on the Leaflet map and handles all editing interactions.
 * Hit testing is done here (in layer pixel space) instead of with Leaflet layer events,
 * so tools behave consistently regardless of what is drawn on top of what.
 */
export class RailroadEditor {
    private store = useRailroadStore()
    private renderer: L.SVG
    private casingLayer = L.layerGroup()
    private lineLayer = L.layerGroup()
    private nodeLayer = L.layerGroup()
    private preview: L.Polyline
    private renderQueued = false
    private drag?: { nodeId: string, started: boolean, start: L.Point }
    private suppressClick = false
    private lastMouse?: { latlng: L.LatLng, shift: boolean }
    private disposers: (() => void)[] = []

    constructor(private map: L.Map) {
        const linePane = map.createPane('railroadLines')
        linePane.style.zIndex = '440'
        linePane.style.pointerEvents = 'none'
        const nodePane = map.createPane('railroadNodes')
        nodePane.style.zIndex = '450'
        nodePane.style.pointerEvents = 'none'

        this.renderer = L.svg({ pane: 'railroadLines', padding: 0.5 })
        this.casingLayer.addTo(map)
        this.lineLayer.addTo(map)
        this.nodeLayer.addTo(map)
        this.preview = L.polyline([], {
            pane: 'railroadLines', renderer: this.renderer, interactive: false,
            color: '#111', weight: 3, dashArray: '6 8', opacity: 0.9,
        }).addTo(map)

        this.disposers.push(watch(() => this.store.project, () => this.queueRender(), { deep: true }))
        this.disposers.push(watch(() => [this.store.selection, this.store.drawing, this.store.transferStart, this.store.showLabels, this.store.visible, this.store.open, this.store.tool], () => this.queueRender(), { deep: true }))
        this.disposers.push(watch(() => this.store.open, (open) => {
            if (open) map.doubleClickZoom.disable()
            else map.doubleClickZoom.enable()
            this.updateCursorClass()
        }, { immediate: true }))
        this.disposers.push(watch(() => this.store.tool, () => this.updateCursorClass()))

        map.on('zoomend', () => this.queueRender())
        map.on('viewreset', () => this.queueRender())
        map.on('click', (e: L.LeafletMouseEvent) => this.onClick(e))
        map.on('mousedown', (e: L.LeafletMouseEvent) => this.onMouseDown(e))
        map.on('mousemove', (e: L.LeafletMouseEvent) => this.onMouseMove(e))
        map.on('mouseout', () => this.preview.setLatLngs([]))
        map.on('contextmenu', (e: L.LeafletMouseEvent) => this.onContextMenu(e))
        const onMouseUp = (e: MouseEvent) => this.onMouseUp(e)
        const onKeyDown = (e: KeyboardEvent) => this.onKeyDown(e)
        document.addEventListener('mouseup', onMouseUp)
        document.addEventListener('keydown', onKeyDown)
        this.disposers.push(() => {
            document.removeEventListener('mouseup', onMouseUp)
            document.removeEventListener('keydown', onKeyDown)
        })

        this.render()
    }

    destroy() {
        this.disposers.forEach(d => d())
        this.disposers = []
    }

    /** true when the editor wants to own the right click (so the map does not copy a /tp command) */
    get consumesContextMenu() {
        return this.store.open && this.store.tool !== 'select'
    }

    // ===================== coordinates =====================

    static toLatLng(x: number, z: number) {
        return L.latLng(-z, x)
    }

    static toWorld(latlng: L.LatLng) {
        return { x: Math.round(latlng.lng), z: Math.round(-latlng.lat) }
    }

    private nodePoint(n: { x: number, z: number }) {
        return this.map.latLngToLayerPoint(RailroadEditor.toLatLng(n.x, n.z))
    }

    // ===================== view helpers =====================

    fitToNetwork() {
        const nodes = this.store.project.nodes
        if (nodes.length === 0) return
        const b = M.bounds(nodes)
        const bounds = L.latLngBounds(RailroadEditor.toLatLng(b.minX, b.minZ), RailroadEditor.toLatLng(b.maxX, b.maxZ))
        if (b.minX === b.maxX && b.minZ === b.maxZ) {
            this.map.setView(bounds.getCenter(), Math.max(this.map.getZoom(), -1))
        } else {
            this.map.fitBounds(bounds.pad(0.15), { maxZoom: 0 })
        }
    }

    flyTo(x: number, z: number) {
        this.map.setView(RailroadEditor.toLatLng(x, z), Math.max(this.map.getZoom(), -1))
    }

    // ===================== rendering =====================

    queueRender() {
        if (this.renderQueued) return
        this.renderQueued = true
        requestAnimationFrame(() => {
            this.renderQueued = false
            this.render()
        })
    }

    private updateCursorClass() {
        const container = this.map.getContainer()
        for (const c of Array.from(container.classList)) {
            if (c.startsWith('rr-tool-')) container.classList.remove(c)
        }
        if (this.store.open) container.classList.add(`rr-tool-${this.store.tool}`)
    }

    render() {
        this.casingLayer.clearLayers()
        this.lineLayer.clearLayers()
        this.nodeLayer.clearLayers()

        const store = this.store
        if (!store.visible && !store.open) {
            this.preview.setLatLngs([])
            return
        }

        const p = store.project
        const nodes = store.nodesById
        const usage = M.segmentUsage(p)
        const sel = store.selection
        const activeLineId = store.drawing?.lineId ?? (sel?.kind === 'line' ? sel.id : undefined)

        // ---- lines ----
        const ordered = [...p.lines].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'service' ? -1 : 1))
        for (const line of ordered) {
            const highlighted = line.id === activeLineId
            for (let i = 1; i < line.nodeIds.length; i++) {
                const a = nodes.get(line.nodeIds[i - 1]), b = nodes.get(line.nodeIds[i])
                if (!a || !b) continue
                const latlngs = this.offsetSegment(a, b, M.laneOffset(usage, a.id, b.id, line.id) * LANE_SPACING)
                if (highlighted) {
                    L.polyline(latlngs, { renderer: this.renderer, interactive: false, color: '#ffe600', weight: LINE_WEIGHT + 12, opacity: 0.75, lineCap: 'round' }).addTo(this.casingLayer)
                }
                if (line.kind === 'service') {
                    L.polyline(latlngs, { renderer: this.renderer, interactive: false, color: '#ffffff', weight: 6, opacity: 0.8, lineCap: 'round' }).addTo(this.casingLayer)
                    L.polyline(latlngs, { renderer: this.renderer, interactive: false, color: line.color, weight: 3, dashArray: '7 6', lineCap: 'butt' }).addTo(this.lineLayer)
                } else {
                    L.polyline(latlngs, { renderer: this.renderer, interactive: false, color: '#ffffff', weight: LINE_WEIGHT + 4, opacity: 0.9, lineCap: 'round' }).addTo(this.casingLayer)
                    L.polyline(latlngs, { renderer: this.renderer, interactive: false, color: line.color, weight: LINE_WEIGHT, lineCap: 'round', lineJoin: 'round' }).addTo(this.lineLayer)
                    // double track: a thin light stripe in the middle makes the line read as two tracks
                    if (M.trackType(p, a.id, b.id) === 'double') {
                        L.polyline(latlngs, { renderer: this.renderer, interactive: false, color: '#ffffff', weight: 1.5, opacity: 0.9, lineCap: 'butt' }).addTo(this.lineLayer)
                    }
                }
            }
        }

        // ---- transfers ----
        for (const t of p.transfers) {
            const a = nodes.get(t.a), b = nodes.get(t.b)
            if (!a || !b) continue
            const latlngs = [RailroadEditor.toLatLng(a.x, a.z), RailroadEditor.toLatLng(b.x, b.z)]
            if (sel?.kind === 'transfer' && sel.id === t.id) {
                L.polyline(latlngs, { renderer: this.renderer, interactive: false, color: '#ffe600', weight: 16, opacity: 0.75 }).addTo(this.casingLayer)
            }
            L.polyline(latlngs, { renderer: this.renderer, interactive: false, color: '#1d1d1b', weight: 8, lineCap: 'round' }).addTo(this.lineLayer)
            L.polyline(latlngs, { renderer: this.renderer, interactive: false, color: '#ffffff', weight: 4, lineCap: 'round' }).addTo(this.lineLayer)
        }

        // ---- nodes ----
        for (const node of p.nodes) {
            if (node.type === 'waypoint' && !store.open) continue
            const selected = sel?.kind === 'node' && sel.id === node.id
            const html = this.nodeHtml(p, node, selected)
            const icon = L.divIcon({ className: 'rr-icon', html, iconSize: [0, 0] })
            L.marker(RailroadEditor.toLatLng(node.x, node.z), {
                icon, pane: 'railroadNodes', interactive: false, keyboard: false,
                zIndexOffset: node.type === 'waypoint' ? 0 : node.type === 'terminal' ? 300 : 200,
            }).addTo(this.nodeLayer)
        }

        this.updatePreview()
    }

    /** Segment latlngs shifted sideways by `offsetPx` screen pixels, relative to the canonical (id-ordered) direction */
    private offsetSegment(a: RailNode, b: RailNode, offsetPx: number): L.LatLng[] {
        const la = RailroadEditor.toLatLng(a.x, a.z), lb = RailroadEditor.toLatLng(b.x, b.z)
        if (offsetPx === 0) return [la, lb]
        const pa = this.map.latLngToLayerPoint(la), pb = this.map.latLngToLayerPoint(lb)
        const [from, to] = a.id < b.id ? [pa, pb] : [pb, pa]
        const dx = to.x - from.x, dy = to.y - from.y
        const len = Math.hypot(dx, dy) || 1
        const shift = L.point(-dy / len * offsetPx, dx / len * offsetPx)
        return [this.map.layerPointToLatLng(pa.add(shift)), this.map.layerPointToLatLng(pb.add(shift))]
    }

    private nodeHtml(p: RailProject, node: RailNode, selected: boolean): string {
        const store = this.store
        const classes = ['rr-node', `rr-${node.type}`]
        if (selected) classes.push('rr-selected')
        if (store.transferStart === node.id) classes.push('rr-transfer-start')
        let style = ''
        if (node.type === 'station' || node.type === 'terminal') {
            const integ = M.integrationsOf(p, node.id, store.nodesById)
            if (M.isInterchange(integ)) classes.push('rr-interchange')
            else if (integ.lines.length === 1) style = `--rr-color:${integ.lines[0].color}`
        } else if (node.type === 'waypoint') {
            const line = p.lines.find(l => l.nodeIds.includes(node.id))
            if (line) style = `--rr-color:${line.color}`
        }
        let html = `<div class="${classes.join(' ')}" style="${style}">${node.type === 'depot' ? 'D' : ''}</div>`
        if (store.showLabels && node.type !== 'waypoint' && node.name) {
            html += `<div class="rr-label rr-label-${node.type}">${M.escapeHtml(node.name)}</div>`
        }
        return html
    }

    private updatePreview() {
        const d = this.store.drawing
        if (!d || !this.lastMouse || !this.store.open) {
            this.preview.setLatLngs([])
            return
        }
        const line = this.store.project.lines.find(l => l.id === d.lineId)
        const lastId = line ? (d.atStart ? line.nodeIds[0] : line.nodeIds[line.nodeIds.length - 1]) : undefined
        const last = lastId ? this.store.nodesById.get(lastId) : undefined
        if (!line || !last) {
            this.preview.setLatLngs([])
            return
        }
        const target = this.trackTarget(this.map.latLngToLayerPoint(this.lastMouse.latlng), this.lastMouse.latlng, last, this.lastMouse.shift)
        this.preview.setStyle({ color: line.color })
        this.preview.setLatLngs([RailroadEditor.toLatLng(last.x, last.z), RailroadEditor.toLatLng(target.x, target.z)])
    }

    // ===================== hit testing =====================

    private hitNode(pt: L.Point, opts: { exclude?: string, namedOnly?: boolean } = {}): RailNode | undefined {
        let best: RailNode | undefined
        let bestDist = Infinity
        for (const n of this.store.project.nodes) {
            if (n.id === opts.exclude) continue
            if (opts.namedOnly && n.type === 'waypoint') continue
            const d = this.nodePoint(n).distanceTo(pt)
            const radius = n.type === 'waypoint' ? NODE_HIT_RADIUS - 3 : NODE_HIT_RADIUS
            // prefer named nodes over waypoints when both are in range
            const score = d + (n.type === 'waypoint' ? 2 : 0)
            if (d <= radius && score < bestDist) {
                best = n
                bestDist = score
            }
        }
        return best
    }

    private hitSegment(pt: L.Point): SegmentHit | undefined {
        const nodes = this.store.nodesById
        const usage = M.segmentUsage(this.store.project)
        let best: SegmentHit | undefined
        let bestDist = Infinity
        for (const [key, lineIds] of usage) {
            const [aId, bId] = key.split('|')
            const a = nodes.get(aId), b = nodes.get(bId)
            if (!a || !b) continue
            const pa = this.nodePoint(a), pb = this.nodePoint(b)
            const proj = M.projectOnSegment(pt, pa, pb)
            const tolerance = SEGMENT_HIT_RADIUS + (lineIds.length - 1) * LANE_SPACING / 2
            if (proj.dist <= tolerance && proj.dist < bestDist) {
                bestDist = proj.dist
                best = { lineIds, a: aId, b: bId, point: L.point(proj.x, proj.y) }
            }
        }
        return best
    }

    private hitTransfer(pt: L.Point): string | undefined {
        const nodes = this.store.nodesById
        for (const t of this.store.project.transfers) {
            const a = nodes.get(t.a), b = nodes.get(t.b)
            if (!a || !b) continue
            if (M.projectOnSegment(pt, this.nodePoint(a), this.nodePoint(b)).dist <= SEGMENT_HIT_RADIUS) return t.id
        }
        return undefined
    }

    /** Where a track click at `pt` would place the next point (snapped) */
    private trackTarget(pt: L.Point, latlng: L.LatLng, last: RailNode | undefined, shift: boolean): { x: number, z: number, node?: RailNode } {
        const node = this.hitNode(pt)
        if (node) return { x: node.x, z: node.z, node }
        const world = RailroadEditor.toWorld(latlng)
        const doSnap = this.store.snap !== shift
        if (last && doSnap) return M.snapOctilinear(last, world)
        return world
    }

    // ===================== interaction =====================

    private onContextMenu(e: L.LeafletMouseEvent) {
        if (!this.consumesContextMenu) return
        e.originalEvent.preventDefault()
        if (this.store.drawing) this.store.finishDrawing()
        else if (this.store.transferStart) this.store.transferStart = undefined
        else this.store.setTool('select')
    }

    private onClick(e: L.LeafletMouseEvent) {
        if (!this.store.open) return
        if (this.suppressClick) {
            this.suppressClick = false
            return
        }
        const pt = e.layerPoint
        const shift = e.originalEvent.shiftKey
        switch (this.store.tool) {
            case 'select': return this.clickSelect(pt)
            case 'track': return this.clickTrack(pt, e.latlng, shift)
            case 'station':
            case 'terminal':
            case 'depot': return this.clickPlace(this.store.tool, pt, e.latlng)
            case 'transfer': return this.clickTransfer(pt)
            case 'delete': return this.clickDelete(pt)
            case 'tracktype': return this.clickTrackType(pt)
        }
    }

    private clickSelect(pt: L.Point) {
        const store = this.store
        const node = this.hitNode(pt)
        if (node) {
            store.selection = { kind: 'node', id: node.id }
            return
        }
        const transfer = this.hitTransfer(pt)
        if (transfer) {
            store.selection = { kind: 'transfer', id: transfer }
            return
        }
        const seg = this.hitSegment(pt)
        if (seg) {
            // clicking repeatedly on shared track cycles through the lines
            const current = store.selection?.kind === 'line' ? seg.lineIds.indexOf(store.selection.id) : -1
            store.selection = { kind: 'line', id: seg.lineIds[(current + 1) % seg.lineIds.length] }
            return
        }
        store.selection = undefined
    }

    private clickTrack(pt: L.Point, latlng: L.LatLng, shift: boolean) {
        const store = this.store
        const p = store.project
        const hitNode = this.hitNode(pt)

        if (!store.drawing) {
            const selectedLine = store.selection?.kind === 'line' ? p.lines.find(l => l.id === store.selection!.id) : undefined

            // continue the selected line from one of its ends
            if (hitNode && selectedLine && selectedLine.nodeIds.length > 0) {
                if (selectedLine.nodeIds[selectedLine.nodeIds.length - 1] === hitNode.id) {
                    store.drawing = { lineId: selectedLine.id, atStart: false }
                    return
                } else if (selectedLine.nodeIds[0] === hitNode.id) {
                    store.drawing = { lineId: selectedLine.id, atStart: true }
                    return
                }
            }

            const seg = hitNode ? undefined : this.hitSegment(pt)
            store.edit(p => {
                // an empty selected line gets its first point, otherwise a new line starts
                const line = selectedLine && selectedLine.nodeIds.length === 0
                    ? selectedLine
                    : M.addLine(p, store.defaultLineName())
                let start = hitNode
                if (!start && seg) {
                    const w = RailroadEditor.toWorld(this.map.layerPointToLatLng(seg.point))
                    start = M.addNode(p, 'waypoint', w.x, w.z)
                    M.insertIntoSegment(p, seg.a, seg.b, start.id)
                }
                if (!start) {
                    const w = RailroadEditor.toWorld(latlng)
                    start = M.addNode(p, 'waypoint', w.x, w.z)
                }
                line.nodeIds.push(start.id)
                store.drawing = { lineId: line.id, atStart: false }
                store.selection = { kind: 'line', id: line.id }
            })
            return
        }

        const d = store.drawing
        const line = p.lines.find(l => l.id === d.lineId)
        if (!line) {
            store.drawing = undefined
            return
        }
        const lastId = d.atStart ? line.nodeIds[0] : line.nodeIds[line.nodeIds.length - 1]
        const last = store.nodesById.get(lastId)

        if (hitNode && hitNode.id === lastId) {
            store.finishDrawing()
            return
        }
        const prevId = d.atStart ? line.nodeIds[1] : line.nodeIds[line.nodeIds.length - 2]
        if (hitNode && hitNode.id === prevId) return

        const seg = hitNode ? undefined : this.hitSegment(pt)
        const closesLoop = hitNode !== undefined && hitNode.id === (d.atStart ? line.nodeIds[line.nodeIds.length - 1] : line.nodeIds[0])

        store.edit(p => {
            let node = hitNode
            if (!node && seg && !(seg.a === lastId || seg.b === lastId)) {
                const w = RailroadEditor.toWorld(this.map.layerPointToLatLng(seg.point))
                node = M.addNode(p, 'waypoint', w.x, w.z)
                M.insertIntoSegment(p, seg.a, seg.b, node.id)
            }
            if (!node) {
                const target = this.trackTarget(pt, latlng, last, shift)
                node = M.addNode(p, 'waypoint', target.x, target.z)
            }
            const l = p.lines.find(l => l.id === d.lineId)!
            if (d.atStart) l.nodeIds.unshift(node.id)
            else l.nodeIds.push(node.id)
            if (p.settings.newTrack === 'single') M.setTrackType(p, lastId, node.id, 'single')
        })
        if (closesLoop) store.finishDrawing()
    }

    private clickPlace(type: NodeType, pt: L.Point, latlng: L.LatLng) {
        const store = this.store
        const hitNode = this.hitNode(pt)
        if (hitNode) {
            if (hitNode.type !== type) {
                const name = hitNode.type === 'waypoint' || !hitNode.name ? store.nextName(type) : hitNode.name
                store.edit(() => {
                    hitNode.type = type
                    hitNode.name = name
                })
            }
            store.selection = { kind: 'node', id: hitNode.id }
            return
        }
        const seg = this.hitSegment(pt)
        const node = store.edit(p => {
            if (seg) {
                const w = RailroadEditor.toWorld(this.map.layerPointToLatLng(seg.point))
                const n = M.addNode(p, type, w.x, w.z, store.nextName(type))
                M.insertIntoSegment(p, seg.a, seg.b, n.id)
                return n
            }
            const w = RailroadEditor.toWorld(latlng)
            return M.addNode(p, type, w.x, w.z, store.nextName(type))
        })
        store.selection = { kind: 'node', id: node.id }
    }

    private clickTransfer(pt: L.Point) {
        const store = this.store
        const node = this.hitNode(pt, { namedOnly: true })
        if (!node) {
            store.transferStart = undefined
            return
        }
        if (!store.transferStart) {
            store.transferStart = node.id
            return
        }
        if (store.transferStart === node.id) {
            store.transferStart = undefined
            return
        }
        const a = store.transferStart
        const t = store.edit(p => M.addTransfer(p, a, node.id))
        store.transferStart = undefined
        if (t) store.selection = { kind: 'transfer', id: t.id }
    }

    private clickTrackType(pt: L.Point) {
        const seg = this.hitSegment(pt)
        if (!seg) return
        this.store.edit(p => M.setTrackType(p, seg.a, seg.b, M.trackType(p, seg.a, seg.b) === 'single' ? 'double' : 'single'))
    }

    private clickDelete(pt: L.Point) {
        const store = this.store
        const node = this.hitNode(pt)
        if (node) {
            store.edit(p => M.deleteNode(p, node.id))
            store.validateUiState()
            return
        }
        const transfer = this.hitTransfer(pt)
        if (transfer) {
            store.edit(p => { p.transfers = p.transfers.filter(t => t.id !== transfer) })
            store.validateUiState()
            return
        }
        const seg = this.hitSegment(pt)
        if (seg) {
            // removing a piece of track splits the line(s) using it
            store.edit(p => splitAtSegment(p, seg.a, seg.b))
            store.validateUiState()
        }
    }

    private onMouseDown(e: L.LeafletMouseEvent) {
        if (!this.store.open || this.store.tool !== 'select' || e.originalEvent.button !== 0) return
        const node = this.hitNode(e.layerPoint)
        if (!node) return
        this.map.dragging.disable()
        this.drag = { nodeId: node.id, started: false, start: e.containerPoint }
        this.store.selection = { kind: 'node', id: node.id }
    }

    private onMouseMove(e: L.LeafletMouseEvent) {
        this.lastMouse = { latlng: e.latlng, shift: e.originalEvent.shiftKey }
        const drag = this.drag
        if (drag) {
            if (!drag.started && drag.start.distanceTo(e.containerPoint) > 3) {
                drag.started = true
                this.store.edit(() => { /* history checkpoint before moving */ })
            }
            if (drag.started) {
                const node = this.store.nodesById.get(drag.nodeId)
                if (node) {
                    const w = RailroadEditor.toWorld(e.latlng)
                    node.x = w.x
                    node.z = w.z
                    this.store.touch()
                }
            }
            return
        }
        if (this.store.open) {
            const container = this.map.getContainer()
            const hovering = this.store.tool === 'tracktype'
                ? this.hitSegment(e.layerPoint) !== undefined
                : this.store.tool !== 'track' && this.hitNode(e.layerPoint) !== undefined
            container.classList.toggle('rr-hover-node', hovering)
            this.updatePreview()
        }
    }

    private onMouseUp(e: MouseEvent) {
        const drag = this.drag
        if (!drag) return
        this.drag = undefined
        this.map.dragging.enable()
        if (!drag.started) return
        this.suppressClick = true
        setTimeout(() => this.suppressClick = false, 50)

        const store = this.store
        const node = store.nodesById.get(drag.nodeId)
        if (!node) return
        const target = this.hitNode(this.nodePoint(node), { exclude: node.id })
        if (!target) return
        // dropping onto another node joins them (only if one of them is a plain track point)
        if (node.type === 'waypoint') {
            store.edit(p => M.mergeNodes(p, target.id, node.id), false)
            store.selection = { kind: 'node', id: target.id }
        } else if (target.type === 'waypoint') {
            node.x = target.x
            node.z = target.z
            store.edit(p => M.mergeNodes(p, node.id, target.id), false)
        }
    }

    private onKeyDown(e: KeyboardEvent) {
        const store = this.store
        if (!store.open || store.exportOpen || store.projectsOpen) return
        const target = e.target as HTMLElement | null
        if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
        // let focused buttons keep their keyboard activation
        if (target && ['BUTTON', 'A'].includes(target.tagName) && (e.key === 'Enter' || e.key === ' ')) return

        const ctrl = e.ctrlKey || e.metaKey
        const key = e.key.toLowerCase()
        if (ctrl && key === 'z' && !e.shiftKey) { store.undo(); e.preventDefault(); return }
        if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) { store.redo(); e.preventDefault(); return }
        if (ctrl || e.altKey) return

        switch (key) {
            case 'escape':
                if (store.drawing) store.finishDrawing()
                else if (store.transferStart) store.transferStart = undefined
                else store.selection = undefined
                break
            case 'enter': store.finishDrawing(); break
            case 'delete':
            case 'backspace': store.deleteSelection(); break
            case 'v': store.setTool('select'); break
            case 't': store.setTool('track'); break
            case 's': store.setTool('station'); break
            case 'r': store.setTool('terminal'); break
            case 'd': store.setTool('depot'); break
            case 'x': store.setTool('transfer'); break
            case 'e': store.setTool('delete'); break
            case 'k': store.setTool('tracktype'); break
            case 'g': store.snap = !store.snap; break
            case 'l': store.showLabels = !store.showLabels; break
            case 'f': this.fitToNetwork(); break
            default: return
        }
        e.preventDefault()
    }
}

/** Removes the segment a-b from every line using it, splitting those lines in two. */
function splitAtSegment(p: RailProject, a: string, b: string) {
    const created: RailLine[] = []
    for (const line of p.lines) {
        for (let i = 1; i < line.nodeIds.length; i++) {
            const prev = line.nodeIds[i - 1], cur = line.nodeIds[i]
            if ((prev === a && cur === b) || (prev === b && cur === a)) {
                const rest = line.nodeIds.splice(i)
                if (rest.length >= 2) {
                    created.push({ ...line, id: M.uid('l_'), nodeIds: rest })
                }
                break
            }
        }
    }
    p.lines.push(...created)
    M.cleanupLines(p)
    M.pruneOrphanWaypoints(p)
}
