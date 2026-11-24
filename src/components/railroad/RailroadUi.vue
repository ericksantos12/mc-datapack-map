<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';
import { useRailroadStore } from '../../stores/useRailroadStore';
import RailroadToolbar from './RailroadToolbar.vue';
import RailroadPanel from './RailroadPanel.vue';
import RailroadProjectsDialog from './RailroadProjectsDialog.vue';
import RailroadExportDialog from './RailroadExportDialog.vue';

/*
 * All railroad planner UI lives in this component (instead of MainMap's template) so that
 * planner state changes never force MainMap to re-render. MainMap's template evaluates
 * world-generation computeds that can throw while datapacks are being reloaded.
 */
const store = useRailroadStore()

const stop = watch(() => store.open, (open) => {
    document.getElementById('map_container')?.classList.toggle('railroad-open', open)
}, { immediate: true, flush: 'post' })

onBeforeUnmount(stop)
</script>

<template>
    <RailroadToolbar v-if="store.open" />
    <RailroadPanel v-if="store.open" />
    <Teleport to="body">
        <RailroadProjectsDialog v-if="store.projectsOpen" />
        <RailroadExportDialog v-if="store.exportOpen" />
        <Transition>
            <div class="message" :class="{ error: store.message.error }" v-if="store.message">
                {{ store.message.text }}
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.message {
    position: fixed;
    z-index: 7000;
    left: 50%;
    transform: translateX(-50%);
    top: 3.2rem;
    padding: 0.3rem 1rem;
    border-radius: 1rem;
    background-color: rgb(3, 33, 58);
    color: white;
    user-select: none;
}

.message.error {
    background-color: rgb(165, 33, 33);
    border: 2px solid white;
}

.v-enter-active,
.v-leave-active {
    transition: opacity 0.3s ease;
}

.v-enter-from,
.v-leave-to {
    opacity: 0;
}
</style>
