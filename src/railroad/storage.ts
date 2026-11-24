import { createStore, del, get, set, values } from "idb-keyval"
import { sanitizeProject, summarize } from "./model.js"
import type { ProjectSummary, RailProject } from "./types.js"

const store = createStore('railroad-planner', 'projects')
const LAST_PROJECT_KEY = 'railroad-planner.last-project'

function plain(p: RailProject): RailProject {
    return JSON.parse(JSON.stringify(p))
}

export async function saveProject(p: RailProject) {
    await set(p.id, plain(p), store)
}

export async function loadProject(id: string): Promise<RailProject | undefined> {
    const raw = await get(id, store)
    if (raw === undefined) return undefined
    try {
        return sanitizeProject(raw)
    } catch (e) {
        console.warn('Stored railroad project is invalid', e)
        return undefined
    }
}

export async function deleteProject(id: string) {
    await del(id, store)
    if (getLastProjectId() === id) setLastProjectId(undefined)
}

export async function listProjects(): Promise<ProjectSummary[]> {
    const all = await values(store)
    const summaries: ProjectSummary[] = []
    for (const raw of all) {
        try {
            summaries.push(summarize(sanitizeProject(raw)))
        } catch {
            // ignore broken entries
        }
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getLastProjectId(): string | undefined {
    try {
        return localStorage.getItem(LAST_PROJECT_KEY) ?? undefined
    } catch {
        return undefined
    }
}

export function setLastProjectId(id: string | undefined) {
    try {
        if (id) localStorage.setItem(LAST_PROJECT_KEY, id)
        else localStorage.removeItem(LAST_PROJECT_KEY)
    } catch {
        // storage unavailable
    }
}

export function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function readFileAsText(file: File): Promise<string> {
    return file.text()
}
