<script setup lang="ts">
import { computed } from 'vue';
import type { RailLine } from '../../railroad/types';

const props = defineProps<{ line: RailLine, small?: boolean }>()

const textColor = computed(() => {
    const v = parseInt(props.line.color.slice(1), 16)
    const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255
    return (0.299 * r + 0.587 * g + 0.114 * b) > 170 ? '#1d1d1b' : '#ffffff'
})
</script>

<template>
    <span class="badge" :class="{ small, service: line.kind === 'service' }" :style="{ backgroundColor: line.color, color: textColor }" :title="line.name">{{ line.code || '•' }}</span>
</template>

<style scoped>
.badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.5rem;
    height: 1.5rem;
    padding: 0 0.3rem;
    box-sizing: border-box;
    border-radius: 0.75rem;
    font-weight: 800;
    font-size: 0.75rem;
    flex-shrink: 0;
    border: 2px solid rgba(255, 255, 255, 0.85);
}

.badge.small {
    min-width: 1.1rem;
    height: 1.1rem;
    font-size: 0.6rem;
    padding: 0 0.2rem;
    border-width: 1px;
}

.badge.service {
    border-style: dashed;
}
</style>
