<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Identifier } from 'deepslate';
import { useRailroadStore } from '../../stores/useRailroadStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { mapContext } from '../../railroad/mapContext';
import { EmptyNetworkError, renderPoster, type PosterOptions } from '../../railroad/exportPng';
import { downloadBlob } from '../../railroad/storage';
import * as M from '../../railroad/model';

const i18n = useI18n()
const store = useRailroadStore()
const settingsStore = useSettingsStore()

const OPTIONS_KEY = 'railroad-planner.export-options'
const SIZES = [1600, 2400, 3200, 4800]

const defaults = {
    longSide: 2400,
    panelOpacity: 0.85,
    showBackground: true,
    showLegend: true,
    showIntegrations: true,
    showServiceTracks: true,
    showDepots: true,
    showScale: true,
    layout: 'schematic' as 'schematic' | 'geographic',
    footer: '',
}

function loadOptions() {
    try {
        const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}')
        return { ...defaults, ...(typeof saved === 'object' && saved ? saved : {}) }
    } catch {
        return { ...defaults }
    }
}

const options = reactive(loadOptions())
if (!SIZES.includes(options.longSide)) options.longSide = defaults.longSide
watch(options, () => {
    try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(options)) } catch { /* ignore */ }
})

const previewUrl = ref<string>()
const busy = ref(false)
const progress = ref(0)
const error = ref<string>()

const defaultSubtitle = computed(() => {
    const w = store.project.world
    const version = i18n.t(`settings.mc_version.mc${w.mc_version}`)
    let dimension = w.dimension
    try {
        dimension = settingsStore.getLocalizedName('dimension', Identifier.parse(w.dimension), false)
    } catch { /* keep raw */ }
    return i18n.t('railroad.export.default_subtitle', { seed: w.seed, version, dimension })
})

function posterOptions(longSide: number): PosterOptions {
    return {
        title: store.project.title,
        subtitle: store.project.subtitle || defaultSubtitle.value,
        footer: options.footer || i18n.t('railroad.export.default_footer'),
        longSide,
        panelOpacity: options.panelOpacity,
        showBackground: options.showBackground,
        showLegend: options.showLegend,
        showIntegrations: options.showIntegrations,
        showServiceTracks: options.showServiceTracks,
        showDepots: options.showDepots,
        showScale: options.showScale,
        layout: options.layout === 'geographic' ? 'geographic' : 'schematic',
        labels: {
            lines: i18n.t('railroad.poster.lines'),
            legend: i18n.t('railroad.poster.lines'),
            station: i18n.t('railroad.poster.station'),
            interchange: i18n.t('railroad.poster.interchange'),
            terminal: i18n.t('railroad.poster.terminal'),
            depot: i18n.t('railroad.poster.depot'),
            transfer: i18n.t('railroad.poster.transfer'),
            service: i18n.t('railroad.poster.service'),
            blocks: i18n.t('railroad.poster.blocks'),
            double: i18n.t('railroad.poster.double'),
            single: i18n.t('railroad.poster.single'),
            lineStats: (_line, stops, length, seconds) => i18n.t('railroad.poster.line_stats', {
                stops, length: M.formatBlocks(length), time: M.formatDuration(seconds),
            }),
        },
    }
}

async function render(longSide: number) {
    error.value = undefined
    busy.value = true
    progress.value = 0
    try {
        const run = () => renderPoster(store.project, posterOptions(longSide), mapContext.renderBiomeRegion, (f) => progress.value = f)
        try {
            return await run()
        } catch (e) {
            // the map was regenerating (seed / dimension change): try once more with the new settings
            if (e instanceof EmptyNetworkError) throw e
            return await run()
        }
    } catch (e) {
        error.value = e instanceof EmptyNetworkError ? i18n.t('railroad.export.empty') : i18n.t('railroad.export.failed', { error: (e as Error).message ?? `${e}` })
        console.error(e)
        return undefined
    } finally {
        busy.value = false
    }
}

async function updatePreview() {
    const canvas = await render(1100)
    if (canvas) previewUrl.value = canvas.toDataURL('image/png')
}

async function download() {
    const canvas = await render(options.longSide)
    if (!canvas) return
    canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, `${M.safeFileName(store.project.title)}.png`)
        else error.value = i18n.t('railroad.export.failed', { error: `${canvas.width}×${canvas.height}px` })
    }, 'image/png')
}

function inputValue(e: Event) {
    return (e.target as HTMLInputElement).value
}

onMounted(updatePreview)
</script>

<template>
    <div class="backdrop" @click.self="store.exportOpen = false" @keydown.esc="store.exportOpen = false">
        <div class="dialog" role="dialog" aria-modal="true" :aria-label="i18n.t('railroad.export.title')">
            <header>
                <h2><font-awesome-icon icon="fa-image" /> {{ i18n.t('railroad.export.title') }}</h2>
                <button class="icon-button" :title="i18n.t('railroad.close')" :aria-label="i18n.t('railroad.close')" @click="store.exportOpen = false">
                    <font-awesome-icon icon="fa-xmark" />
                </button>
            </header>
            <div class="content">
                <div class="form">
                    <label class="field">
                        <span>{{ i18n.t('railroad.export.poster_title') }}</span>
                        <input :value="store.project.title" maxlength="200" @input="e => store.textEdit('project.title', () => { store.project.title = inputValue(e) })" />
                    </label>
                    <label class="field">
                        <span>{{ i18n.t('railroad.export.subtitle') }}</span>
                        <input :value="store.project.subtitle" :placeholder="defaultSubtitle" maxlength="200" @input="e => store.textEdit('project.subtitle', () => { store.project.subtitle = inputValue(e) })" />
                    </label>
                    <label class="field">
                        <span>{{ i18n.t('railroad.export.footer') }}</span>
                        <input v-model="options.footer" :placeholder="i18n.t('railroad.export.default_footer')" maxlength="200" />
                    </label>
                    <label class="field">
                        <span>{{ i18n.t('railroad.export.layout') }}</span>
                        <select v-model="options.layout">
                            <option value="schematic">{{ i18n.t('railroad.export.layout.schematic') }}</option>
                            <option value="geographic">{{ i18n.t('railroad.export.layout.geographic') }}</option>
                        </select>
                    </label>
                    <label class="field">
                        <span>{{ i18n.t('railroad.export.resolution') }}</span>
                        <select v-model.number="options.longSide">
                            <option v-for="s in SIZES" :key="s" :value="s">{{ s }} px</option>
                        </select>
                    </label>
                    <label class="field">
                        <span>{{ i18n.t('railroad.export.panel_opacity') }}: {{ Math.round(options.panelOpacity * 100) }}%</span>
                        <input type="range" min="0.4" max="1" step="0.01" v-model.number="options.panelOpacity" />
                    </label>
                    <label class="check"><input type="checkbox" v-model="options.showBackground" /> {{ i18n.t('railroad.export.show_background') }}</label>
                    <label class="check"><input type="checkbox" v-model="options.showLegend" /> {{ i18n.t('railroad.export.show_legend') }}</label>
                    <label class="check"><input type="checkbox" v-model="options.showIntegrations" /> {{ i18n.t('railroad.export.show_integrations') }}</label>
                    <label class="check"><input type="checkbox" v-model="options.showServiceTracks" /> {{ i18n.t('railroad.export.show_service') }}</label>
                    <label class="check"><input type="checkbox" v-model="options.showDepots" /> {{ i18n.t('railroad.export.show_depots') }}</label>
                    <label class="check" v-if="options.layout === 'geographic'"><input type="checkbox" v-model="options.showScale" /> {{ i18n.t('railroad.export.show_scale') }}</label>
                    <div class="buttons">
                        <button class="button" :disabled="busy" @click="updatePreview">
                            <font-awesome-icon icon="fa-rotate-right" /> {{ i18n.t('railroad.export.preview') }}
                        </button>
                        <button class="button primary" :disabled="busy" @click="download">
                            <font-awesome-icon icon="fa-download" /> {{ i18n.t('railroad.export.download') }}
                        </button>
                    </div>
                </div>
                <div class="preview">
                    <div class="status" v-if="busy">{{ i18n.t('railroad.export.rendering', { percent: Math.round(progress * 100) }) }}</div>
                    <div class="status error" v-else-if="error">{{ error }}</div>
                    <img v-if="previewUrl" :src="previewUrl" :class="{ stale: busy }" alt="" />
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.backdrop {
    position: fixed;
    inset: 0;
    background-color: rgba(0, 0, 0, 0.6);
    z-index: 6000;
    display: flex;
    align-items: center;
    justify-content: center;
}

.dialog {
    width: min(78rem, 96vw);
    height: min(52rem, 92vh);
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    background-color: rgb(3, 33, 58);
    color: white;
    border-radius: 0.9rem;
    padding: 1rem 1.2rem;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
    box-sizing: border-box;
}

header {
    display: flex;
    align-items: center;
    justify-content: space-between;
}

h2 {
    margin: 0;
    font-size: 1.2rem;
}

.content {
    display: flex;
    gap: 1rem;
    flex-grow: 1;
    min-height: 0;
}

.form {
    width: 17rem;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    overflow-y: auto;
    font-size: 0.9rem;
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

input:not([type=checkbox]):not([type=range]),
select {
    box-sizing: border-box;
    background-color: lightgray;
    color: black;
    border-radius: 0.3rem;
    border: 2px solid rgb(55, 120, 173);
    padding: 0.25rem 0.4rem;
    font: inherit;
}

.check {
    display: flex;
    align-items: center;
    gap: 0.4rem;
}

.buttons {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-top: 0.5rem;
}

.preview {
    flex-grow: 1;
    min-width: 0;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    background: repeating-conic-gradient(rgb(20, 50, 75) 0% 25%, rgb(15, 42, 65) 0% 50%) 50% / 24px 24px;
    border-radius: 0.6rem;
    overflow: hidden;
}

.preview img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    transition: opacity 0.2s;
}

.preview img.stale {
    opacity: 0.4;
}

.status {
    position: absolute;
    top: 0.8rem;
    left: 50%;
    transform: translateX(-50%);
    background-color: rgba(3, 33, 58, 0.9);
    padding: 0.3rem 0.9rem;
    border-radius: 1rem;
    z-index: 1;
    font-size: 0.9rem;
}

.status.error {
    background-color: rgb(140, 35, 35);
}

.button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 0.5rem 0.8rem;
    border-radius: 0.4rem;
    border: none;
    background-color: rgb(40, 70, 96);
    color: white;
    cursor: pointer;
    font: inherit;
}

.button:hover:not(:disabled) {
    background-color: rgb(70, 105, 135);
}

.button.primary {
    background-color: rgb(135, 156, 14);
}

.button.primary:hover:not(:disabled) {
    background-color: rgb(168, 192, 30);
}

.button:disabled {
    opacity: 0.5;
    cursor: default;
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

@media (max-width: 800px) {
    .content {
        flex-direction: column;
    }

    .form {
        width: 100%;
        max-height: 40%;
    }
}
</style>
