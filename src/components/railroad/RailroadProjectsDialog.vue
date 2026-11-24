<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRailroadStore } from '../../stores/useRailroadStore';
import type { ProjectSummary } from '../../railroad/types';

const i18n = useI18n()
const store = useRailroadStore()
const fileInput = ref<HTMLInputElement>()

function formatDate(ts: number) {
    return new Date(ts).toLocaleString(i18n.locale.value.replace('_', '-'))
}

async function remove(p: ProjectSummary) {
    if (window.confirm(i18n.t('railroad.project.delete_confirm', { title: p.title }))) {
        await store.removeProject(p.id)
    }
}

async function onFile(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (file) await store.importProject(file)
}

async function create() {
    await store.newProject()
    store.projectsOpen = false
}
</script>

<template>
    <div class="backdrop" @click.self="store.projectsOpen = false" @keydown.esc="store.projectsOpen = false">
        <div class="dialog" role="dialog" aria-modal="true" :aria-label="i18n.t('railroad.project.projects')">
            <header>
                <h2><font-awesome-icon icon="fa-folder-open" /> {{ i18n.t('railroad.project.projects') }}</h2>
                <button class="icon-button" :title="i18n.t('railroad.close')" :aria-label="i18n.t('railroad.close')" @click="store.projectsOpen = false">
                    <font-awesome-icon icon="fa-xmark" />
                </button>
            </header>
            <div class="actions">
                <button class="button primary" @click="create"><font-awesome-icon icon="fa-plus" /> {{ i18n.t('railroad.project.new') }}</button>
                <button class="button" @click="store.duplicateProject()"><font-awesome-icon icon="fa-clone" /> {{ i18n.t('railroad.project.duplicate') }}</button>
                <button class="button" @click="fileInput?.click()"><font-awesome-icon icon="fa-file-import" /> {{ i18n.t('railroad.project.import') }}</button>
                <button class="button" @click="store.exportProjectJson()"><font-awesome-icon icon="fa-download" /> {{ i18n.t('railroad.project.export_json') }}</button>
                <input ref="fileInput" type="file" accept=".json,application/json" hidden @change="onFile" />
            </div>
            <p class="note">{{ i18n.t('railroad.project.autosave_note') }}</p>
            <ul class="list" v-if="store.projects.length > 0">
                <li v-for="p in store.projects" :key="p.id" :class="{ current: p.id === store.project.id }">
                    <button class="open" @click="store.openProject(p.id)">
                        <span class="title">{{ p.title }} <span class="tag" v-if="p.id === store.project.id">{{ i18n.t('railroad.project.current') }}</span></span>
                        <span class="sub">{{ i18n.t('railroad.project.summary', { stations: p.stations, lines: p.lines, seed: p.seed }) }}</span>
                        <span class="sub">{{ i18n.t('railroad.project.updated', { date: formatDate(p.updatedAt) }) }}</span>
                    </button>
                    <button class="icon-button danger" :title="i18n.t('railroad.project.delete')" :aria-label="i18n.t('railroad.project.delete')" @click="remove(p)">
                        <font-awesome-icon icon="fa-trash-can" />
                    </button>
                </li>
            </ul>
            <p class="empty" v-else>{{ i18n.t('railroad.project.list_empty') }}</p>
        </div>
    </div>
</template>

<style scoped>
.backdrop {
    position: fixed;
    inset: 0;
    background-color: rgba(0, 0, 0, 0.55);
    z-index: 6000;
    display: flex;
    align-items: center;
    justify-content: center;
}

.dialog {
    width: min(36rem, 94vw);
    max-height: 86vh;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    background-color: rgb(3, 33, 58);
    color: white;
    border-radius: 0.9rem;
    padding: 1rem 1.2rem;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
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

.actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
}

.note {
    margin: 0;
    font-size: 0.8rem;
    color: rgb(170, 195, 215);
}

.list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
}

.list li {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    background-color: rgb(16, 56, 90);
    border-radius: 0.5rem;
    border: 1px solid transparent;
}

.list li.current {
    border-color: rgb(193, 224, 17);
}

.open {
    flex-grow: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
    background: none;
    border: none;
    color: white;
    text-align: start;
    padding: 0.5rem 0.7rem;
    cursor: pointer;
    font: inherit;
    border-radius: 0.5rem;
}

.open:hover {
    background-color: rgb(30, 70, 105);
}

.title {
    font-weight: 700;
}

.tag {
    font-size: 0.7rem;
    background-color: rgb(193, 224, 17);
    color: rgb(3, 33, 58);
    border-radius: 0.5rem;
    padding: 0 0.4rem;
    margin-inline-start: 0.3rem;
}

.sub {
    font-size: 0.78rem;
    color: rgb(170, 195, 215);
}

.empty {
    color: rgb(170, 195, 215);
    text-align: center;
}

.button {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.4rem 0.7rem;
    border-radius: 0.4rem;
    border: none;
    background-color: rgb(40, 70, 96);
    color: white;
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
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

.icon-button {
    background: none;
    border: none;
    color: white;
    cursor: pointer;
    font-size: 1.1rem;
    padding: 0.4rem 0.6rem;
    border-radius: 0.3rem;
}

.icon-button:hover {
    background-color: rgb(40, 70, 96);
}

.icon-button.danger:hover {
    background-color: rgb(140, 35, 35);
}
</style>
