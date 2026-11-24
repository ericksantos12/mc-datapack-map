import { defineStore } from "pinia";
import { computed, nextTick, ref, toRaw, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Identifier } from "deepslate";
import { useSettingsStore } from "./useSettingsStore.js";
import { useDatapackStore } from "./useDatapackStore.js";
import { parseSeed, versionMetadata } from "../util.js";
import * as M from "../railroad/model.js";
import * as Storage from "../railroad/storage.js";
import type { NodeType, ProjectSummary, RailProject, Selection, Tool, WorldSettings } from "../railroad/types.js";

const OPEN_KEY = 'railroad-planner.open'
const HISTORY_LIMIT = 150

type Snapshot = Pick<RailProject, 'title' | 'subtitle' | 'settings' | 'nodes' | 'lines' | 'transfers' | 'singleTrack'>

export const useRailroadStore = defineStore('railroad', () => {
    const settingsStore = useSettingsStore()
    const datapackStore = useDatapackStore()
    const i18n = useI18n()

    // ============ UI state ============
    const open = ref(readOpen())
    const visible = ref(true)
    const showLabels = ref(true)
    const snap = ref(true)
    const tool = ref<Tool>('select')
    const selection = ref<Selection>()
    const drawing = ref<{ lineId: string, atStart: boolean }>()
    const transferStart = ref<string>()
    const exportOpen = ref(false)
    const projectsOpen = ref(false)
    const message = ref<{ text: string, error?: boolean }>()

    watch(open, (value) => {
        try { localStorage.setItem(OPEN_KEY, `${value}`) } catch { /* ignore */ }
        if (!value) setTool('select')
    })

    // ============ project ============
    const project = ref<RailProject>(M.createProject(currentWorld(), i18n.t('railroad.project.untitled')))
    const projects = ref<ProjectSummary[]>([])
    const persisted = ref(false)
    const saveState = ref<'saved' | 'saving' | 'unsaved' | 'error'>('saved')

    const nodesById = computed(() => M.nodeMap(project.value))

    // ============ history ============
    const undoStack: string[] = []
    const redoStack: string[] = []
    const canUndo = ref(false)
    const canRedo = ref(false)

    function snapshot(): string {
        const p = toRaw(project.value)
        const s: Snapshot = { title: p.title, subtitle: p.subtitle, settings: p.settings, nodes: p.nodes, lines: p.lines, transfers: p.transfers, singleTrack: p.singleTrack }
        return JSON.stringify(s)
    }

    function restore(json: string) {
        const s = JSON.parse(json) as Snapshot
        Object.assign(project.value, s)
        validateUiState()
        touch()
    }

    function updateHistoryFlags() {
        canUndo.value = undoStack.length > 0
        canRedo.value = redoStack.length > 0
    }

    function resetHistory() {
        undoStack.length = 0
        redoStack.length = 0
        updateHistoryFlags()
    }

    function pushHistory() {
        undoStack.push(snapshot())
        if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
        redoStack.length = 0
        updateHistoryFlags()
    }

    function undo() {
        const prev = undoStack.pop()
        if (prev === undefined) return
        lastTextKey = undefined
        drawing.value = undefined
        redoStack.push(snapshot())
        restore(prev)
        updateHistoryFlags()
    }

    function redo() {
        const next = redoStack.pop()
        if (next === undefined) return
        lastTextKey = undefined
        drawing.value = undefined
        undoStack.push(snapshot())
        restore(next)
        updateHistoryFlags()
    }

    let lastTextKey: string | undefined

    /** Runs a mutation on the project, recording undo history. */
    function edit<T>(fn: (p: RailProject) => T, history = true): T {
        lastTextKey = undefined
        if (history) pushHistory()
        const result = fn(project.value)
        touch()
        return result
    }

    /**
     * Call on every input event of a text field bound to the project.
     * Consecutive typing into the same field is grouped into one undo step.
     */
    function textEdit(key: string, mutate: () => void) {
        if (lastTextKey !== key) {
            pushHistory()
            lastTextKey = key
        }
        mutate()
        touch()
    }

    function validateUiState() {
        const p = project.value
        const sel = selection.value
        if (sel) {
            const exists = sel.kind === 'node' ? p.nodes.some(n => n.id === sel.id)
                : sel.kind === 'line' ? p.lines.some(l => l.id === sel.id)
                    : p.transfers.some(t => t.id === sel.id)
            if (!exists) selection.value = undefined
        }
        if (drawing.value && !p.lines.some(l => l.id === drawing.value!.lineId)) drawing.value = undefined
        if (transferStart.value && !p.nodes.some(n => n.id === transferStart.value)) transferStart.value = undefined
    }

    // ============ saving ============
    let saveTimer: ReturnType<typeof setTimeout> | undefined

    function touch() {
        project.value.updatedAt = Date.now()
        saveState.value = 'unsaved'
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => { save() }, 700)
    }

    async function save() {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined }
        // do not litter the project list with untouched empty projects
        const p = project.value
        if (!persisted.value && M.isEmptyProject(p)) {
            saveState.value = 'saved'
            return
        }
        saveState.value = 'saving'
        try {
            await Storage.saveProject(p)
            if (project.value === p) {
                persisted.value = true
                Storage.setLastProjectId(p.id)
                saveState.value = 'saved'
            }
            await refreshList()
        } catch (e) {
            console.error(e)
            if (project.value === p) saveState.value = 'error'
        }
    }

    async function refreshList() {
        try {
            projects.value = await Storage.listProjects()
        } catch (e) {
            console.error(e)
        }
    }

    // ============ world settings ============
    function currentWorld(): WorldSettings {
        return {
            seed: settingsStore.seed.toString(),
            mc_version: settingsStore.mc_version,
            world_preset: settingsStore.world_preset.toString(),
            dimension: settingsStore.dimension.toString(),
            datapacks: datapackStore.datapacks.flatMap(d => d.id ? [d.id] : []),
        }
    }

    let restoringWorld = false

    watch(() => [settingsStore.seed, settingsStore.mc_version, settingsStore.world_preset.toString(), settingsStore.dimension.toString(), datapackStore.datapacks.map(d => d.id ?? '').join(',')], () => {
        if (restoringWorld) return
        const w = currentWorld()
        if (JSON.stringify(w) === JSON.stringify(project.value.world)) return
        project.value.world = w
        touch()
    })

    async function applyWorld(w: WorldSettings) {
        restoringWorld = true
        try {
            await applyWorldSettings(w)
        } finally {
            // let the settings watchers run before syncing again
            await nextTick()
            restoringWorld = false
        }
    }

    async function applyWorldSettings(w: WorldSettings) {
        if (versionMetadata[w.mc_version] !== undefined && w.mc_version !== settingsStore.mc_version) {
            settingsStore.mc_version = w.mc_version
        }
        if (w.world_preset !== settingsStore.world_preset.toString()) {
            settingsStore.world_preset = Identifier.parse(w.world_preset)
        }
        if (w.dimension !== settingsStore.dimension.toString()) {
            settingsStore.dimension = Identifier.parse(w.dimension)
        }
        const seed = parseSeed(w.seed)
        if (seed !== settingsStore.seed) {
            settingsStore.seed = seed
        }
        const present = new Set(datapackStore.datapacks.map(d => d.id))
        for (const id of w.datapacks) {
            if (present.has(id)) continue
            if (/^modrinth:[A-Za-z0-9_-]{1,64}$/.test(id)) {
                try {
                    await datapackStore.addModrinthDatapack(id.substring('modrinth:'.length))
                } catch (e) {
                    console.warn(`Could not restore datapack ${id}`, e)
                }
            }
        }
    }

    // ============ project management ============
    function setProject(p: RailProject, isPersisted: boolean) {
        drawing.value = undefined
        transferStart.value = undefined
        selection.value = undefined
        project.value = p
        persisted.value = isPersisted
        saveState.value = 'saved'
        resetHistory()
    }

    /**
     * Replaces the current project immediately (so no edit can land in the old one),
     * then stores the previous project if it has anything worth keeping.
     */
    async function switchTo(next: RailProject, nextPersisted: boolean) {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined }
        if (project.value.id === next.id) return
        const prev = project.value
        const prevPersisted = persisted.value
        setProject(next, nextPersisted)
        if (prev.id !== next.id && (prevPersisted || !M.isEmptyProject(prev))) {
            try {
                await Storage.saveProject(prev)
            } catch (e) {
                console.error(e)
                flash(i18n.t('railroad.project.save_error'), true)
            }
        }
        await refreshList()
    }

    async function newProject() {
        Storage.setLastProjectId(undefined)
        await switchTo(M.createProject(currentWorld(), i18n.t('railroad.project.untitled')), false)
    }

    async function openProject(id: string, applyWorldSettings = true) {
        if (id === project.value.id) {
            projectsOpen.value = false
            return true
        }
        const p = await Storage.loadProject(id)
        if (!p) {
            flash(i18n.t('railroad.message.open_failed'), true)
            return false
        }
        Storage.setLastProjectId(p.id)
        await switchTo(p, true)
        if (applyWorldSettings) await applyWorld(p.world)
        projectsOpen.value = false
        return true
    }

    async function duplicateProject() {
        const copy = M.sanitizeProject(JSON.parse(JSON.stringify(toRaw(project.value))))
        copy.id = M.uid('p_')
        copy.title = i18n.t('railroad.project.copy_of', { title: copy.title })
        copy.createdAt = copy.updatedAt = Date.now()
        await switchTo(copy, true)
        await save()
    }

    async function removeProject(id: string) {
        await Storage.deleteProject(id)
        if (id === project.value.id) {
            if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined }
            setProject(M.createProject(currentWorld(), i18n.t('railroad.project.untitled')), false)
        }
        await refreshList()
    }

    async function importProject(file: File) {
        try {
            const text = await file.text()
            const p = M.sanitizeProject(JSON.parse(text))
            if (projects.value.some(s => s.id === p.id)) {
                p.id = M.uid('p_')
            }
            await switchTo(p, true)
            await save()
            await applyWorld(p.world)
            projectsOpen.value = false
            flash(i18n.t('railroad.message.imported', { title: p.title }))
        } catch (e) {
            console.error(e)
            flash(i18n.t('railroad.message.import_failed'), true)
        }
    }

    function exportProjectJson() {
        const blob = new Blob([JSON.stringify(toRaw(project.value), null, 2)], { type: 'application/json' })
        Storage.downloadBlob(blob, `${M.safeFileName(project.value.title)}.railroad.json`)
    }

    async function init() {
        await refreshList()
        const lastId = Storage.getLastProjectId()
        if (!lastId) return
        const p = await Storage.loadProject(lastId)
        if (!p) return
        // Only reopen automatically if the URL does not explicitly ask for a different seed
        const urlSeed = new URLSearchParams(window.location.search).get('seed')
        if (urlSeed !== null && parseSeed(urlSeed).toString() !== p.world.seed) return
        // the user started drawing before the stored project finished loading: keep their work
        if (!M.isEmptyProject(project.value) || persisted.value) return
        setProject(p, true)
        await applyWorld(p.world)
    }

    // ============ messages ============
    let messageTimer: ReturnType<typeof setTimeout> | undefined
    function flash(text: string, error = false) {
        message.value = { text, error }
        if (messageTimer) clearTimeout(messageTimer)
        messageTimer = setTimeout(() => message.value = undefined, 3000)
    }

    // ============ editing helpers ============
    function nextName(type: NodeType): string {
        const names = new Set(project.value.nodes.map(n => n.name))
        let n = project.value.nodes.filter(node => node.type === type).length + 1
        let name: string
        do {
            name = i18n.t(`railroad.default_name.${type}`, { n })
            n++
        } while (names.has(name))
        return name
    }

    function setTool(t: Tool) {
        finishDrawing()
        transferStart.value = undefined
        tool.value = t
    }

    function finishDrawing() {
        const d = drawing.value
        if (!d) return
        drawing.value = undefined
        const line = project.value.lines.find(l => l.id === d.lineId)
        if (line && line.nodeIds.length < 2) {
            // a line with a single point is not a track: drop it (part of the same undo step)
            M.deleteLine(project.value, line.id)
            if (selection.value?.id === line.id) selection.value = undefined
            touch()
        }
    }

    function deleteSelection() {
        const sel = selection.value
        if (!sel) return
        edit(p => {
            if (sel.kind === 'node') M.deleteNode(p, sel.id)
            else if (sel.kind === 'line') M.deleteLine(p, sel.id)
            else p.transfers = p.transfers.filter(t => t.id !== sel.id)
        })
        selection.value = undefined
        validateUiState()
    }

    function extendLine(lineId: string, atStart: boolean) {
        setTool('track')
        drawing.value = { lineId, atStart }
        selection.value = { kind: 'line', id: lineId }
    }

    function defaultLineName() {
        return i18n.t('railroad.default_name.line', { n: '{n}' })
    }

    function newLine() {
        finishDrawing()
        const line = edit(p => M.addLine(p, defaultLineName()))
        selection.value = { kind: 'line', id: line.id }
        tool.value = 'track'
        drawing.value = { lineId: line.id, atStart: false }
        return line
    }

    function reverseLine(lineId: string) {
        if (drawing.value?.lineId === lineId) drawing.value = { lineId, atStart: !drawing.value.atStart }
        edit(p => {
            const line = p.lines.find(l => l.id === lineId)
            line?.nodeIds.reverse()
        })
    }

    return {
        // state
        open, visible, showLabels, snap, tool, selection, drawing, transferStart, exportOpen, projectsOpen, message,
        project, projects, persisted, saveState, nodesById, canUndo, canRedo,
        // history / editing
        edit, textEdit, undo, redo, touch, validateUiState, nextName, setTool, finishDrawing, deleteSelection, extendLine, newLine, reverseLine, defaultLineName,
        // persistence
        save, init, refreshList, newProject, openProject, duplicateProject, removeProject, importProject, exportProjectJson, currentWorld, applyWorld,
        flash,
    }
})

function readOpen() {
    try {
        return localStorage.getItem(OPEN_KEY) === 'true'
    } catch {
        return false
    }
}
