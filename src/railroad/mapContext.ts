import type * as L from "leaflet"

export type BiomeRegionRenderer = (
    minX: number, minZ: number, maxX: number, maxZ: number,
    widthPx: number, heightPx: number,
    onProgress?: (fraction: number) => void
) => Promise<HTMLCanvasElement>

/**
 * Non-reactive handles to map objects that live in MainMap, shared with the railroad UI.
 */
export const mapContext: {
    map?: L.Map
    renderBiomeRegion?: BiomeRegionRenderer
    fitToNetwork?: () => void
    flyTo?: (x: number, z: number) => void
} = {}
