<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { DensityFunction } from 'deepslate';
import { useRailroadStore } from '../../stores/useRailroadStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useLoadedDimensionStore } from '../../stores/useLoadedDimensionStore';
import { mapContext } from '../../railroad/mapContext';
import * as M from '../../railroad/model';
import { LINE_COLORS } from '../../railroad/model';
import type { NodeType, RailLine, RailNode } from '../../railroad/types';
import LineBadge from './LineBadge.vue';

const i18n = useI18n()
const store = useRailroadStore()
const settingsStore = useSettingsStore()
const loadedDimensionStore = useLoadedDimensionStore()

const search = ref('')

const nodeTypes: NodeType[] = ['station', 'terminal', 'depot', 'waypoint']

const nodeTypeIcons: Record<NodeType, string> = {
    station: 'fa-circle-dot',
    terminal: 'fa-flag-checkered',
    depot: 'fa-warehouse',
    waypoint: 'fa-circle',
}

const selectedNode = computed(() => store.selection?.kind === 'node' ? store.nodesById.get(store.selection.id) : undefined)
const selectedLine = computed(() => store.selection?.kind === 'line' ? store.project.lines.find(l => l.id === store.selection!.id) : undefined)
const selectedTransfer = computed(() => store.selection?.kind === 'transfer' ? store.project.transfers.find(t => t.id === store.selection!.id) : undefined)

const nodeLines = computed(() => selectedNode.value ? M.linesAtNode(store.project, selectedNode.value.id) : [])
const nodeTransfers = computed(() => {
    const node = selectedNode.value
    if (!node) return []
    return M.transfersAtNode(store.project, node.id)
        .map(t => store.nodesById.get(t.a === node.id ? t.b : t.a))
        .filter((n): n is RailNode => n !== undefined)
})

const namedNodes = computed(() => store.project.nodes.filter(n => n.type !== 'waypoint'))
const filteredStations = computed(() => {
    const q = search.value.trim().toLocaleLowerCase()
    const list = q ? namedNodes.value.filter(n => n.name.toLocaleLowerCase().includes(q)) : namedNodes.value
    return [...list].sort((a, b) => settingsStore.collator.compare(a.name, b.name))
})

const networkSummary = computed(() => i18n.t('railroad.network.summary', {
    stations: namedNodes.value.filter(n => n.type !== 'depot').length,
    lines: store.project.lines.filter(l => l.kind === 'line').length,
    length: M.formatBlocks(M.networkLength(store.project, store.nodesById)),
}))

const trackSummary = computed(() => {
    const t = M.trackStats(store.project, store.project.lines, store.nodesById)
    return i18n.t('railroad.track.summary', { double: M.formatBlocks(t.double), single: M.formatBlocks(t.single), rails: M.formatBlocks(t.rails) })
})

function lineTrackSummary(line: RailLine) {
    const t = M.trackStats(store.project, [line], store.nodesById)
    return i18n.t('railroad.track.line_summary', { double: M.formatBlocks(t.double), single: M.formatBlocks(t.single) })
}

function setLineTrack(line: RailLine, type: 'single' | 'double') {
    store.edit(p => M.setLineTrackType(p, line, type))
}

function setNewTrack(value: string) {
    store.edit(p => { p.settings.newTrack = value === 'single' ? 'single' : 'double' })
}

function lineStats(line: RailLine) {
    const length = M.lineLength(store.project, line, store.nodesById)
    return i18n.t('railroad.line.stats', {
        stops: M.lineStops(store.project, line, store.nodesById).length,
        length: M.formatBlocks(length),
        time: M.formatDuration(length / store.project.settings.trainSpeed),
    })
}

const saveLabel = computed(() => {
    if (!store.persisted && M.isEmptyProject(store.project)) return i18n.t('railroad.project.not_stored')
    return i18n.t(`railroad.project.${store.saveState === 'error' ? 'save_error' : store.saveState}`)
})

function selectNode(node: RailNode, fly = true) {
    store.selection = { kind: 'node', id: node.id }
    if (fly) mapContext.flyTo?.(node.x, node.z)
}

function selectLine(line: RailLine) {
    store.selection = { kind: 'line', id: line.id }
}

function setNodeType(node: RailNode, type: NodeType) {
    const name = node.type === 'waypoint' && !node.name && type !== 'waypoint' ? store.nextName(type) : node.name
    store.edit(() => {
        node.type = type
        node.name = name
    })
}

function setCoord(node: RailNode, axis: 'x' | 'z', value: string) {
    const v = Math.round(Number(value))
    if (!Number.isFinite(v)) return
    store.edit(() => { node[axis] = v })
}

function setLineColor(line: RailLine, color: string) {
    store.edit(() => { line.color = color })
}

function setLineKind(line: RailLine, kind: string) {
    store.edit(() => { line.kind = kind === 'service' ? 'service' : 'line' })
}

function setTrainSpeed(value: string) {
    const v = Number(value)
    if (!Number.isFinite(v) || v <= 0) return
    store.edit(() => { store.project.settings.trainSpeed = Math.min(100, Math.max(0.5, v)) })
}

function copyTp(node: RailNode) {
    let y = '~'
    const surface = loadedDimensionStore.surface_density_function?.compute(DensityFunction.context(node.x, 320, node.z))
    if (surface !== undefined && Number.isFinite(surface)) y = `${Math.round(surface) + 2}`
    navigator.clipboard.writeText(`/execute in ${settingsStore.dimension.toString()} run tp @s ${node.x} ${y} ${node.z}`)
    store.flash(i18n.t('railroad.message.tp_copied'))
}

function inputValue(e: Event) {
    return (e.target as HTMLInputElement).value
}
</script>

<template>
    <aside class="panel" :aria-label="i18n.t('railroad.toggle')">
        <header class="header">
            <font-awesome-icon icon="fa-train-subway" class="logo" />
            <h2>{{ i18n.t('railroad.toggle') }}</h2>
            <button class="icon-button" :title="i18n.t('railroad.close')" :aria-label="i18n.t('railroad.close')" @click="store.open = false">
                <font-awesome-icon icon="fa-xmark" />
            </button>
        </header>

        <div class="scroll">
            <!-- ============ project ============ -->
            <section class="section">
                <input class="title-input" :aria-label="i18n.t('railroad.project.title')" :placeholder="i18n.t('railroad.project.title')"
                    :value="store.project.title" maxlength="200"
                    @input="e => store.textEdit('project.title', () => { store.project.title = inputValue(e) })" />
                <input class="subtitle-input" :aria-label="i18n.t('railroad.project.subtitle')" :placeholder="i18n.t('railroad.project.subtitle')"
                    :value="store.project.subtitle" maxlength="200"
                    @input="e => store.textEdit('project.subtitle', () => { store.project.subtitle = inputValue(e) })" />
                <div class="save-state" :class="store.saveState">
                    <font-awesome-icon :icon="store.saveState === 'saved' ? 'fa-check' : 'fa-floppy-disk'" /> {{ saveLabel }}
                </div>
                <div class="button-row">
                    <button class="button" @click="store.projectsOpen = true; store.refreshList()">
                        <font-awesome-icon icon="fa-folder-open" /> {{ i18n.t('railroad.project.projects') }}
                    </button>
                    <button class="button" :title="i18n.t('railroad.project.export_json')" @click="store.exportProjectJson()">
                        <font-awesome-icon icon="fa-download" /> .json
                    </button>
                    <button class="button primary" @click="store.exportOpen = true">
                        <font-awesome-icon icon="fa-image" /> {{ i18n.t('railroad.project.export_png') }}
                    </button>
                </div>
                <div class="summary">{{ networkSummary }}</div>
                <div class="summary" v-if="store.project.lines.length > 0">{{ trackSummary }}</div>
            </section>

            <!-- ============ selection: node ============ -->
            <section v-if="selectedNode" class="section editor" :key="'node-' + selectedNode.id">
                <div class="editor-title">
                    <font-awesome-icon :icon="nodeTypeIcons[selectedNode.type]" />
                    {{ i18n.t(`railroad.node.type.${selectedNode.type}`) }}
                </div>
                <label class="field" v-if="selectedNode.type !== 'waypoint'">
                    <span>{{ i18n.t('railroad.node.name') }}</span>
                    <input :value="selectedNode.name" maxlength="200"
                        @input="e => store.textEdit('node.name.' + selectedNode!.id, () => { selectedNode!.name = inputValue(e) })" />
                </label>
                <label class="field">
                    <span>{{ i18n.t('railroad.node.type') }}</span>
                    <select :value="selectedNode.type" @change="e => setNodeType(selectedNode!, inputValue(e) as NodeType)">
                        <option v-for="t in nodeTypes" :key="t" :value="t">{{ i18n.t(`railroad.node.type.${t}`) }}</option>
                    </select>
                </label>
                <div class="field">
                    <span>{{ i18n.t('railroad.node.coords') }}</span>
                    <div class="coords">
                        X <input type="number" :value="selectedNode.x" @change="e => setCoord(selectedNode!, 'x', inputValue(e))" />
                        Z <input type="number" :value="selectedNode.z" @change="e => setCoord(selectedNode!, 'z', inputValue(e))" />
                        <button class="icon-button small" :title="i18n.t('railroad.node.copy_tp')" :aria-label="i18n.t('railroad.node.copy_tp')" @click="copyTp(selectedNode!)">
                            <font-awesome-icon icon="fa-copy" />
                        </button>
                    </div>
                </div>
                <template v-if="selectedNode.type !== 'waypoint'">
                    <div class="field">
                        <span>{{ i18n.t('railroad.node.lines') }}</span>
                        <div class="badges" v-if="nodeLines.length > 0">
                            <button v-for="line in nodeLines" :key="line.id" class="badge-button" :title="line.name" @click="selectLine(line)">
                                <LineBadge :line="line" /> {{ line.name }}
                            </button>
                        </div>
                        <div class="muted" v-else>{{ i18n.t('railroad.node.no_lines') }}</div>
                    </div>
                    <div class="field" v-if="nodeTransfers.length > 0">
                        <span>{{ i18n.t('railroad.node.transfers') }}</span>
                        <div class="badges">
                            <button v-for="n in nodeTransfers" :key="n.id" class="badge-button" @click="selectNode(n)">
                                <font-awesome-icon icon="fa-right-left" /> {{ n.name }}
                            </button>
                        </div>
                    </div>
                    <label class="field">
                        <span>{{ i18n.t('railroad.node.integrations') }}</span>
                        <input :value="selectedNode.integrations" maxlength="200" :placeholder="i18n.t('railroad.node.integrations_placeholder')"
                            @input="e => store.textEdit('node.integrations.' + selectedNode!.id, () => { selectedNode!.integrations = inputValue(e) })" />
                    </label>
                    <label class="field">
                        <span>{{ i18n.t('railroad.node.notes') }}</span>
                        <textarea :value="selectedNode.notes" maxlength="2000" rows="2"
                            @input="e => store.textEdit('node.notes.' + selectedNode!.id, () => { selectedNode!.notes = inputValue(e) })"></textarea>
                    </label>
                </template>
                <div class="button-row">
                    <button class="button danger" @click="store.deleteSelection()">
                        <font-awesome-icon icon="fa-trash-can" /> {{ i18n.t('railroad.delete') }}
                    </button>
                </div>
            </section>

            <!-- ============ selection: line ============ -->
            <section v-if="selectedLine" class="section editor" :key="'line-' + selectedLine.id">
                <div class="editor-title">
                    <LineBadge :line="selectedLine" /> {{ selectedLine.name }}
                </div>
                <div class="field-row">
                    <label class="field grow">
                        <span>{{ i18n.t('railroad.line.name') }}</span>
                        <input :value="selectedLine.name" maxlength="200"
                            @input="e => store.textEdit('line.name.' + selectedLine!.id, () => { selectedLine!.name = inputValue(e) })" />
                    </label>
                    <label class="field code">
                        <span>{{ i18n.t('railroad.line.code') }}</span>
                        <input :value="selectedLine.code" maxlength="4"
                            @input="e => store.textEdit('line.code.' + selectedLine!.id, () => { selectedLine!.code = inputValue(e) })" />
                    </label>
                </div>
                <div class="field">
                    <span>{{ i18n.t('railroad.line.color') }}</span>
                    <div class="colors">
                        <button v-for="c in LINE_COLORS" :key="c" class="swatch" :class="{ active: selectedLine.color === c }" :style="{ backgroundColor: c }"
                            :aria-label="c" @click="setLineColor(selectedLine!, c)"></button>
                        <input type="color" :value="selectedLine.color" :aria-label="i18n.t('railroad.line.color')" @change="e => setLineColor(selectedLine!, inputValue(e))" />
                    </div>
                </div>
                <label class="field">
                    <span>{{ i18n.t('railroad.line.kind') }}</span>
                    <select :value="selectedLine.kind" @change="e => setLineKind(selectedLine!, inputValue(e))">
                        <option value="line">{{ i18n.t('railroad.line.kind.line') }}</option>
                        <option value="service">{{ i18n.t('railroad.line.kind.service') }}</option>
                    </select>
                </label>
                <div class="muted">{{ lineStats(selectedLine) }}</div>
                <div class="muted" v-if="selectedLine.nodeIds.length > 1">{{ lineTrackSummary(selectedLine) }}</div>
                <div class="button-row wrap" v-if="selectedLine.nodeIds.length > 1">
                    <button class="button small" @click="setLineTrack(selectedLine!, 'double')">
                        <font-awesome-icon icon="fa-grip-lines" /> {{ i18n.t('railroad.track.set_line_double') }}
                    </button>
                    <button class="button small" @click="setLineTrack(selectedLine!, 'single')">
                        <font-awesome-icon icon="fa-minus" /> {{ i18n.t('railroad.track.set_line_single') }}
                    </button>
                </div>
                <div class="muted" v-if="selectedLine.nodeIds.length === 0">{{ i18n.t('railroad.line.empty') }}</div>
                <div class="field" v-if="M.lineStops(store.project, selectedLine, store.nodesById).length > 0">
                    <span>{{ i18n.t('railroad.line.stops') }}</span>
                    <ol class="stops" :style="{ '--line-color': selectedLine.color }">
                        <li v-for="(stop, index) in M.lineStops(store.project, selectedLine, store.nodesById)" :key="stop.id + '-' + index">
                            <button class="link" @click="selectNode(stop)">{{ stop.name || i18n.t(`railroad.node.type.${stop.type}`) }}</button>
                        </li>
                    </ol>
                </div>
                <div class="button-row wrap">
                    <button class="button" v-if="selectedLine.nodeIds.length > 0" @click="store.extendLine(selectedLine!.id, false)">
                        <font-awesome-icon icon="fa-route" /> {{ i18n.t('railroad.line.extend_end') }}
                    </button>
                    <button class="button" v-if="selectedLine.nodeIds.length > 0" @click="store.extendLine(selectedLine!.id, true)">
                        <font-awesome-icon icon="fa-route" /> {{ i18n.t('railroad.line.extend_start') }}
                    </button>
                    <button class="button" @click="store.reverseLine(selectedLine!.id)">
                        <font-awesome-icon icon="fa-right-left" /> {{ i18n.t('railroad.line.reverse') }}
                    </button>
                    <button class="button danger" @click="store.deleteSelection()">
                        <font-awesome-icon icon="fa-trash-can" /> {{ i18n.t('railroad.delete') }}
                    </button>
                </div>
            </section>

            <!-- ============ selection: transfer ============ -->
            <section v-if="selectedTransfer" class="section editor">
                <div class="editor-title">
                    <font-awesome-icon icon="fa-right-left" /> {{ i18n.t('railroad.transfer.title') }}
                </div>
                <div class="transfer">
                    <button class="link" @click="selectNode(store.nodesById.get(selectedTransfer!.a)!)">{{ store.nodesById.get(selectedTransfer.a)?.name }}</button>
                    <font-awesome-icon icon="fa-right-left" />
                    <button class="link" @click="selectNode(store.nodesById.get(selectedTransfer!.b)!)">{{ store.nodesById.get(selectedTransfer.b)?.name }}</button>
                </div>
                <div class="button-row">
                    <button class="button danger" @click="store.deleteSelection()">
                        <font-awesome-icon icon="fa-trash-can" /> {{ i18n.t('railroad.delete') }}
                    </button>
                </div>
            </section>

            <div class="muted empty" v-if="store.project.nodes.length === 0">{{ i18n.t('railroad.empty') }}</div>

            <!-- ============ lines ============ -->
            <section class="section">
                <div class="section-title">
                    {{ i18n.t('railroad.lines') }}
                    <button class="button small" @click="store.newLine()">
                        <font-awesome-icon icon="fa-plus" /> {{ i18n.t('railroad.line.new') }}
                    </button>
                </div>
                <ul class="list">
                    <li v-for="line in store.project.lines" :key="line.id">
                        <button class="row" :class="{ selected: store.selection?.id === line.id }" @click="selectLine(line)">
                            <LineBadge :line="line" />
                            <span class="row-text">
                                <span class="row-name">{{ line.name }}</span>
                                <span class="row-sub">{{ lineStats(line) }}</span>
                            </span>
                        </button>
                    </li>
                </ul>
            </section>

            <!-- ============ stations ============ -->
            <section class="section" v-if="namedNodes.length > 0">
                <div class="section-title">{{ i18n.t('railroad.stations') }}</div>
                <input class="search" v-model="search" :placeholder="i18n.t('railroad.search')" :aria-label="i18n.t('railroad.search')" />
                <ul class="list">
                    <li v-for="node in filteredStations" :key="node.id">
                        <button class="row" :class="{ selected: store.selection?.id === node.id }" @click="selectNode(node)">
                            <font-awesome-icon :icon="nodeTypeIcons[node.type]" class="row-icon" />
                            <span class="row-text">
                                <span class="row-name">{{ node.name }}</span>
                            </span>
                            <span class="mini-badges">
                                <LineBadge v-for="line in M.linesAtNode(store.project, node.id).filter(l => l.kind === 'line')" :key="line.id" :line="line" small />
                            </span>
                        </button>
                    </li>
                </ul>
            </section>

            <!-- ============ settings ============ -->
            <section class="section">
                <label class="field inline">
                    <span>{{ i18n.t('railroad.settings.train_speed') }}</span>
                    <input type="number" min="0.5" max="100" step="0.5" :value="store.project.settings.trainSpeed" @change="e => setTrainSpeed(inputValue(e))" />
                </label>
                <label class="field inline">
                    <span>{{ i18n.t('railroad.track.new_track') }}</span>
                    <select :value="store.project.settings.newTrack" @change="e => setNewTrack(inputValue(e))">
                        <option value="double">{{ i18n.t('railroad.track.double') }}</option>
                        <option value="single">{{ i18n.t('railroad.track.single') }}</option>
                    </select>
                </label>
                <label class="field inline checkbox">
                    <input type="checkbox" v-model="store.visible" />
                    <span>{{ i18n.t('railroad.action.visible') }}</span>
                </label>
            </section>
        </div>
    </aside>
</template>

<style scoped>
.panel {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    bottom: 0.5rem;
    width: 21rem;
    z-index: 1001;
    display: flex;
    flex-direction: column;
    background-color: rgb(3, 33, 58);
    color: white;
    border-radius: 0.8rem;
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.5);
    overflow: hidden;
    font-size: 0.9rem;
}

.header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.8rem;
    background-color: rgb(8, 48, 82);
}

.header h2 {
    font-size: 1.05rem;
    margin: 0;
    flex-grow: 1;
}

.logo {
    color: rgb(193, 224, 17);
}

.scroll {
    overflow-y: auto;
    padding: 0.6rem 0.8rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
}

.section {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
}

.section.editor {
    background-color: rgb(16, 56, 90);
    border-radius: 0.6rem;
    padding: 0.6rem;
    border: 1px solid rgb(55, 120, 173);
}

.section-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: 700;
    text-transform: uppercase;
    font-size: 0.8rem;
    letter-spacing: 0.05em;
    color: rgb(170, 195, 215);
}

.editor-title {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-weight: 700;
}

input,
select,
textarea {
    box-sizing: border-box;
    background-color: lightgray;
    color: black;
    border-radius: 0.3rem;
    border: 2px solid rgb(55, 120, 173);
    padding: 0.2rem 0.4rem;
    font: inherit;
    min-width: 0;
}

textarea {
    resize: vertical;
}

.title-input {
    font-size: 1.05rem;
    font-weight: 700;
}

.field {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
}

.field>span {
    font-size: 0.78rem;
    color: rgb(170, 195, 215);
}

.field.inline {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
}

.field.inline input[type=number] {
    width: 5rem;
}

.field.checkbox {
    justify-content: flex-start;
}

.field-row {
    display: flex;
    gap: 0.5rem;
}

.grow {
    flex-grow: 1;
}

.field.code {
    width: 4.5rem;
}

.coords {
    display: flex;
    align-items: center;
    gap: 0.3rem;
}

.coords input {
    width: 0;
    flex-grow: 1;
}

.colors {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    align-items: center;
}

.swatch {
    width: 1.3rem;
    height: 1.3rem;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.4);
    cursor: pointer;
    padding: 0;
}

.swatch.active {
    border-color: white;
    box-shadow: 0 0 0 2px rgb(193, 224, 17);
}

.colors input[type=color] {
    width: 2rem;
    height: 1.5rem;
    padding: 0;
}

.button-row {
    display: flex;
    gap: 0.4rem;
}

.button-row.wrap {
    flex-wrap: wrap;
}

.button {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.35rem 0.6rem;
    border-radius: 0.4rem;
    border: none;
    background-color: rgb(40, 70, 96);
    color: white;
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
    white-space: nowrap;
}

.button:hover {
    background-color: rgb(70, 105, 135);
}

.button.primary {
    background-color: rgb(135, 156, 14);
}

.button.primary:hover {
    background-color: rgb(168, 192, 30);
}

.button.danger {
    background-color: rgb(140, 35, 35);
}

.button.danger:hover {
    background-color: rgb(180, 45, 45);
}

.button.small {
    padding: 0.2rem 0.45rem;
    font-size: 0.75rem;
    text-transform: none;
    letter-spacing: 0;
}

.icon-button {
    background: none;
    border: none;
    color: white;
    cursor: pointer;
    font-size: 1.1rem;
    padding: 0.2rem 0.4rem;
    border-radius: 0.3rem;
}

.icon-button:hover {
    background-color: rgb(40, 70, 96);
}

.icon-button.small {
    font-size: 0.95rem;
}

.save-state {
    font-size: 0.78rem;
    color: rgb(150, 200, 150);
}

.save-state.unsaved,
.save-state.saving {
    color: rgb(220, 200, 120);
}

.save-state.error {
    color: rgb(255, 120, 120);
}

.summary,
.muted {
    font-size: 0.8rem;
    color: rgb(170, 195, 215);
}

.empty {
    text-align: center;
    padding: 0.5rem;
    border: 1px dashed rgb(55, 120, 173);
    border-radius: 0.5rem;
}

.badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
}

.badge-button {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background-color: rgb(40, 70, 96);
    border: none;
    color: white;
    border-radius: 1rem;
    padding: 0.15rem 0.5rem 0.15rem 0.2rem;
    cursor: pointer;
    font: inherit;
    font-size: 0.8rem;
}

.list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
}

.row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: none;
    border: none;
    color: white;
    text-align: start;
    padding: 0.3rem 0.4rem;
    border-radius: 0.4rem;
    cursor: pointer;
    font: inherit;
}

.row:hover {
    background-color: rgb(30, 62, 90);
}

.row.selected {
    background-color: rgb(40, 80, 115);
}

.row-text {
    display: flex;
    flex-direction: column;
    flex-grow: 1;
    min-width: 0;
}

.row-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.row-sub {
    font-size: 0.72rem;
    color: rgb(170, 195, 215);
}

.row-icon {
    width: 1rem;
    color: rgb(170, 195, 215);
}

.mini-badges {
    display: flex;
    gap: 0.15rem;
}

.search {
    width: 100%;
}

.stops {
    margin: 0;
    padding-inline-start: 1.2rem;
    border-inline-start: 4px solid var(--line-color);
    font-size: 0.85rem;
}

.link {
    background: none;
    border: none;
    color: rgb(140, 200, 255);
    cursor: pointer;
    padding: 0.05rem 0;
    font: inherit;
    text-align: start;
}

.link:hover {
    text-decoration: underline;
}

.transfer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}
</style>
