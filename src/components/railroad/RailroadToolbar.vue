<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRailroadStore } from '../../stores/useRailroadStore';
import { mapContext } from '../../railroad/mapContext';
import type { Tool } from '../../railroad/types';

const i18n = useI18n()
const store = useRailroadStore()

const tools: { tool: Tool, icon: string }[] = [
    { tool: 'select', icon: 'fa-arrow-pointer' },
    { tool: 'track', icon: 'fa-route' },
    { tool: 'tracktype', icon: 'fa-grip-lines' },
    { tool: 'station', icon: 'fa-circle-dot' },
    { tool: 'terminal', icon: 'fa-flag-checkered' },
    { tool: 'depot', icon: 'fa-warehouse' },
    { tool: 'transfer', icon: 'fa-right-left' },
    { tool: 'delete', icon: 'fa-eraser' },
]

const hint = computed(() => {
    if (store.tool === 'track' && store.drawing) {
        const line = store.project.lines.find(l => l.id === store.drawing!.lineId)
        return i18n.t('railroad.hint.track_drawing', { line: line?.name ?? '' })
    }
    if (store.tool === 'transfer' && store.transferStart) {
        return i18n.t('railroad.hint.transfer_second')
    }
    return i18n.t(`railroad.hint.${store.tool}`)
})
</script>

<template>
    <div class="toolbar-wrapper">
        <div class="hint">{{ hint }}</div>
        <div class="toolbar" role="toolbar" :aria-label="i18n.t('railroad.toggle')">
            <button v-for="t in tools" :key="t.tool" class="tool" :class="{ active: store.tool === t.tool }"
                :title="i18n.t(`railroad.tool.${t.tool}`)" :aria-label="i18n.t(`railroad.tool.${t.tool}`)"
                :aria-pressed="store.tool === t.tool" @click="store.setTool(t.tool)">
                <font-awesome-icon :icon="t.icon" />
            </button>
            <span class="separator"></span>
            <button class="tool" :disabled="!store.canUndo" :title="i18n.t('railroad.action.undo')" :aria-label="i18n.t('railroad.action.undo')" @click="store.undo()">
                <font-awesome-icon icon="fa-rotate-left" />
            </button>
            <button class="tool" :disabled="!store.canRedo" :title="i18n.t('railroad.action.redo')" :aria-label="i18n.t('railroad.action.redo')" @click="store.redo()">
                <font-awesome-icon icon="fa-rotate-right" />
            </button>
            <span class="separator"></span>
            <button class="tool" :class="{ active: store.snap }" :title="i18n.t('railroad.action.snap')" :aria-label="i18n.t('railroad.action.snap')" :aria-pressed="store.snap" @click="store.snap = !store.snap">
                <font-awesome-icon icon="fa-magnet" />
            </button>
            <button class="tool" :class="{ active: store.showLabels }" :title="i18n.t('railroad.action.labels')" :aria-label="i18n.t('railroad.action.labels')" :aria-pressed="store.showLabels" @click="store.showLabels = !store.showLabels">
                <font-awesome-icon icon="fa-font" />
            </button>
            <button class="tool" :title="i18n.t('railroad.action.fit')" :aria-label="i18n.t('railroad.action.fit')" @click="mapContext.fitToNetwork?.()">
                <font-awesome-icon icon="fa-expand" />
            </button>
        </div>
    </div>
</template>

<style scoped>
.toolbar-wrapper {
    position: absolute;
    bottom: 1.6rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1001;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.4rem;
    pointer-events: none;
    max-width: calc(100% - 26rem);
}

.hint {
    background-color: rgba(3, 33, 58, 0.85);
    color: rgb(220, 230, 240);
    padding: 0.25rem 0.8rem;
    border-radius: 1rem;
    font-size: 0.85rem;
    text-align: center;
    user-select: none;
}

.toolbar {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.35rem;
    background-color: rgb(3, 33, 58);
    border-radius: 0.8rem;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
}

.tool {
    width: 2.3rem;
    height: 2.3rem;
    border: none;
    border-radius: 0.5rem;
    background-color: rgb(40, 70, 96);
    color: white;
    font-size: 1rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: 0.15s;
}

.tool:hover:not(:disabled) {
    background-color: rgb(70, 105, 135);
}

.tool.active {
    background-color: rgb(193, 224, 17);
    color: rgb(3, 33, 58);
}

.tool:disabled {
    opacity: 0.35;
    cursor: default;
}

.tool:focus-visible {
    outline: 2px solid yellow;
}

.separator {
    width: 1px;
    height: 1.6rem;
    background-color: rgb(70, 105, 135);
    margin: 0 0.2rem;
}
</style>
