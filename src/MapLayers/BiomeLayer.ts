import * as L from "leaflet"
//import { last, range, takeWhile } from "lodash";
import { Climate } from "deepslate";
import { calculateHillshade, getCustomDensityFunction, hashCode } from "../util.js";
import MultiNoiseCalculator from "../webworker/MultiNoiseCalculator?worker"
import { useSearchStore } from "../stores/useBiomeSearchStore.js";
import { useLoadedDimensionStore } from "../stores/useLoadedDimensionStore.js";
import { useSettingsStore } from "../stores/useSettingsStore.js";
import { useDatapackStore } from "../stores/useDatapackStore.js";
import { Ref, toRaw, watch } from "vue";
import { ResourceLocation } from "mc-datapack-loader";

const WORKER_COUNT = 4

type Sample = {
	surface: number,
	biome: string,
	terrain: number
}

type Tile = {
	coords: L.Coords,
	canvas: HTMLCanvasElement,
	ctx: CanvasRenderingContext2D,
	done: L.DoneCallback,
	array?: {
		surface: number,
		biome: string,
		terrain: number
	}[][],
	step?: number,
	isRendering?: boolean,
	workerId: number
}

export class BiomeLayer extends L.GridLayer {
	private next_worker_id = 0

	private Tiles: { [key: string]: Tile } = {}
	private tileSize = 0
	private calcResolution = 0

	private workers: Worker[] = []

	private datapackStore = useDatapackStore()
	private loadedDimensionStore = useLoadedDimensionStore()
	private searchStore = useSearchStore()
	private settingsStore = useSettingsStore()

	private datapackLoader: Promise<any> | undefined

	private generationVersion = 0
	private waveImage: Promise<HTMLImageElement>

	private exportTaskId = 0
	private pendingUpdate: Promise<void> = Promise.resolve()
	private exportTasks = new Map<string, { resolve: (data: { array: Sample[][], step: number }) => void, reject: (e: Error) => void }>()

	constructor(options: L.GridLayerOptions, private do_hillshade: Ref<boolean>, private show_sealevel: Ref<boolean>, private project_down: Ref<boolean>, private y: Ref<number>) {
		super(options)
		this.tileSize = options.tileSize as number
		this.calcResolution = 1 / 4

		this.createWorkers()
		this.datapackLoader = this.updateWorkers({
			dimension: true,
			registires: true,
			settings: true,
		}),

			this.waveImage = new Promise((resolve) => {
				const waveImage = new Image()
				waveImage.onload = () => resolve(waveImage)
				waveImage.src = "images/wave.png"
			})


		watch([this.searchStore.biomes, () => this.searchStore.disabled], ([biomes, disabled], [oldBiomes, oldDisabled]) => {
			// Do not re-render if no biomes were filtered, regardless of the disabled state
			if (oldDisabled !== disabled && oldBiomes.size === 0 && biomes.size === 0) return
			this.rerender() 
		})

		watch(do_hillshade, () => {
			this.rerender()
		})

		watch(show_sealevel, () => {
			this.rerender()
		})

		watch(this.project_down, () => {
			this.updateWorkers({
				settings: true
			})
			this.redraw()
		})

		watch(this.y, () => {
			this.updateWorkers({
				settings: true
			})
			this.redraw()
		})

		this.loadedDimensionStore.$subscribe(async (mutation, state) => {
			await this.updateWorkers({
				settings: true,
				dimension: true,
				registires: true
			})
			this.redraw()
		})

	}

	// ===== Draw tiles that have generated biomes =====
	async renderTile(tile: Tile) {
		tile.isRendering = false
		if (tile.array === undefined || tile.step === undefined) {
			console.warn("trying to render empty tile")
			return
		}

		tile.ctx.clearRect(0, 0, this.tileSize, this.tileSize)

		const waveImage = await this.waveImage

		const project_down = this.project_down.value
		const do_hillshade = this.do_hillshade.value
		const show_sealevel = this.show_sealevel.value
		const getBiomeColor = this.loadedDimensionStore.getBiomeColor

		for (let x = 0; x < this.tileSize * this.calcResolution; x++) {
			for (let z = 0; z < this.tileSize * this.calcResolution; z++) {
				const biome = tile.array[x + 1][z + 1].biome

				if (this.searchStore.biomes.size > 0
					&& !this.searchStore.biomes.has(biome)
					&& !this.searchStore.disabled
				) {
					continue
				}

				let hillshade = 1.0
				const y = project_down ? Math.min(tile.array[x + 1][z + 1].surface, this.y.value) : this.y.value
				const belowSurface = y < tile.array[x + 1][z + 1].surface
				if (do_hillshade && tile.array[x + 1][z + 1].terrain < 0){
					hillshade = 0.15
				} else if (do_hillshade && project_down && !belowSurface) {

					hillshade = calculateHillshade(
						tile.array[x + 2][z + 1].surface - tile.array[x][z + 1].surface,
						tile.array[x + 1][z + 2].surface - tile.array[x + 1][z].surface,
						tile.step
					)
				}

				let biomeColor = getBiomeColor(biome)
				tile.ctx.fillStyle = `rgb(${biomeColor.r * hillshade}, ${biomeColor.g * hillshade}, ${biomeColor.b * hillshade})`

				tile.ctx.fillRect(x / this.calcResolution, z / this.calcResolution, 1 / this.calcResolution, 1 / this.calcResolution)

				if (show_sealevel && !belowSurface) {
					if (y < this.loadedDimensionStore.noise_generator_settings.seaLevel - 2) {
						tile.ctx.drawImage(waveImage, x / this.calcResolution % 16, z / this.calcResolution % 16, 4, 4, x / this.calcResolution, z / this.calcResolution, 4, 4)
					}
				}

			}
		}

	}

	async rerender() {
		console.log("rerendering")
		for (const key in this.Tiles) {
			if (!this.Tiles[key].isRendering) {
				this.Tiles[key].isRendering = true
				setTimeout(() => this.renderTile(this.Tiles[key]), 0)
			}
		}
	}


	// ==== Manage workers to generate biomes of tiles
	private createWorkers() {
		this.workers = []
		for (let i = 0; i < WORKER_COUNT; i++) {
			const worker = new MultiNoiseCalculator()
			worker.onmessage = (ev) => {
				const exportTask = this.exportTasks.get(ev.data.key)
				if (exportTask) {
					this.exportTasks.delete(ev.data.key)
					if (ev.data.generationVersion < this.generationVersion) {
						exportTask.reject(new Error("Map settings changed during export"))
					} else {
						exportTask.resolve({ array: ev.data.array, step: ev.data.step })
					}
					return
				}
				if (ev.data.generationVersion < this.generationVersion) {
					return
				}
				const tile = this.Tiles[ev.data.key]
				if (tile === undefined)
					return

				tile.array = ev.data.array
				tile.step = ev.data.step

				tile.isRendering = true
				this.renderTile(tile)

				tile.done()
				tile.done = () => { /* nothing */ }
			}

			this.workers.push(worker)
		}
	}

	async updateWorkers(do_update: {
		registires?: boolean,
		dimension?: boolean,
		settings?: boolean,
	}) {
		this.generationVersion++
		const update: any = { generationVersion: this.generationVersion }

		this.rejectExportTasks()
		let finishUpdate = () => { }
		this.pendingUpdate = new Promise<void>(resolve => finishUpdate = resolve)

		if (do_update.registires) {
			update.densityFunctions = {}
			for (const id of await this.datapackStore.composite_datapack.getIds(ResourceLocation.WORLDGEN_DENSITY_FUNCTION)) {
				update.densityFunctions[id.toString()] = await this.datapackStore.composite_datapack.get(ResourceLocation.WORLDGEN_DENSITY_FUNCTION, id)
			}

			update.noises = {}
			for (const id of await this.datapackStore.composite_datapack.getIds(ResourceLocation.WORLDGEN_NOISE)) {
				update.noises[id.toString()] = await this.datapackStore.composite_datapack.get(ResourceLocation.WORLDGEN_NOISE, id)
			}
		}

		if (do_update.dimension) {
			update.biomeSourceJson = toRaw(this.loadedDimensionStore.loaded_dimension.biome_source_json)
			update.noiseGeneratorSettingsJson = toRaw(this.loadedDimensionStore.loaded_dimension.noise_settings_json)
			update.surfaceDensityFunctionId = getCustomDensityFunction("snowcapped_surface", this.loadedDimensionStore.loaded_dimension.noise_settings_id!, this.settingsStore.dimension)?.toString() ?? "<none>"
			update.terrainDensityFunctionId = getCustomDensityFunction("map_simple_terrain", this.loadedDimensionStore.loaded_dimension.noise_settings_id!, this.settingsStore.dimension)?.toString() ?? "<none>"
		}

		if (do_update.settings) {
			update.seed = this.settingsStore.seed
			update.y = this.y.value
			update.project_down = this.project_down.value
		}

		// the update clears the workers' task queues: tasks posted meanwhile would never be answered
		this.rejectExportTasks()
		this.workers.forEach(w => w.postMessage({ update }))
		finishUpdate()
	}

	private rejectExportTasks() {
		for (const task of this.exportTasks.values()) {
			task.reject(new Error("Map settings changed during export"))
		}
		this.exportTasks.clear()
	}

	/**
	 * Renders the biome map of an arbitrary block region into a canvas (used by the railroad PNG export).
	 * The region is split into chunks that are computed by the same workers as the map tiles.
	 * The biome search filter is ignored, hillshading follows the current map setting.
	 */
	async renderRegion(minX: number, minZ: number, maxX: number, maxZ: number, widthPx: number, heightPx: number, onProgress?: (fraction: number) => void): Promise<HTMLCanvasElement> {
		await this.datapackLoader
		await this.pendingUpdate

		const CHUNK = 64
		const MAX_SAMPLES = 600_000
		// aim for ~3 output pixels per sample, but limit the total amount of work
		let samplesX = Math.max(1, Math.ceil(widthPx / 3))
		let samplesZ = Math.max(1, Math.ceil(heightPx / 3))
		const factor = Math.sqrt(MAX_SAMPLES / (samplesX * samplesZ))
		if (factor < 1) {
			samplesX = Math.max(1, Math.floor(samplesX * factor))
			samplesZ = Math.max(1, Math.floor(samplesZ * factor))
		}
		const blocksPerSample = Math.max((maxX - minX) / samplesX, (maxZ - minZ) / samplesZ)
		samplesX = Math.ceil((maxX - minX) / blocksPerSample)
		samplesZ = Math.ceil((maxZ - minZ) / blocksPerSample)
		const step = blocksPerSample / 4 // worker coordinates are in quarter blocks

		const canvas = document.createElement("canvas")
		canvas.width = samplesX
		canvas.height = samplesZ
		const ctx = canvas.getContext("2d")!

		const chunksX = Math.ceil(samplesX / CHUNK)
		const chunksZ = Math.ceil(samplesZ / CHUNK)
		const total = chunksX * chunksZ
		let done = 0

		const getBiomeColor = this.loadedDimensionStore.getBiomeColor
		const do_hillshade = this.do_hillshade.value
		const project_down = this.project_down.value
		const yLevel = this.y.value

		const jobs: Promise<void>[] = []
		for (let cx = 0; cx < chunksX; cx++) {
			for (let cz = 0; cz < chunksZ; cz++) {
				const key = `export:${this.exportTaskId++}`
				// shifted by one sample: the worker array has a one sample border used for hillshading
				const min = L.point((minX / 4) + (cx * CHUNK - 1) * step, (minZ / 4) + (cz * CHUNK - 1) * step)
				const max = L.point(min.x + CHUNK * step, min.y + CHUNK * step)
				const worker = this.workers[this.next_worker_id]
				this.next_worker_id = (this.next_worker_id + 1) % WORKER_COUNT

				jobs.push(new Promise<{ array: Sample[][], step: number }>((resolve, reject) => {
					this.exportTasks.set(key, { resolve, reject })
					worker.postMessage({ task: { key, min, max, tileSize: CHUNK } })
				}).then(({ array }) => {
					const w = Math.min(CHUNK, samplesX - cx * CHUNK)
					const h = Math.min(CHUNK, samplesZ - cz * CHUNK)
					const image = ctx.createImageData(w, h)
					for (let x = 0; x < w; x++) {
						for (let z = 0; z < h; z++) {
							const sample = array[x + 1][z + 1]
							let hillshade = 1.0
							const y = project_down ? Math.min(sample.surface, yLevel) : yLevel
							const belowSurface = y < sample.surface
							if (do_hillshade && sample.terrain < 0) {
								hillshade = 0.15
							} else if (do_hillshade && project_down && !belowSurface) {
								hillshade = calculateHillshade(
									array[x + 2][z + 1].surface - array[x][z + 1].surface,
									array[x + 1][z + 2].surface - array[x + 1][z].surface,
									step
								)
							}
							const color = getBiomeColor(sample.biome)
							const i = (z * w + x) * 4
							image.data[i] = color.r * hillshade
							image.data[i + 1] = color.g * hillshade
							image.data[i + 2] = color.b * hillshade
							image.data[i + 3] = 255
						}
					}
					ctx.putImageData(image, cx * CHUNK, cz * CHUNK)
					done++
					onProgress?.(done / total)
				}))
			}
		}

		await Promise.all(jobs)

		// scale to the requested pixel size (the region may be slightly larger due to rounding)
		const out = document.createElement("canvas")
		out.width = Math.round(widthPx)
		out.height = Math.round(heightPx)
		const outCtx = out.getContext("2d")!
		outCtx.imageSmoothingEnabled = false
		const scale = widthPx / (maxX - minX)
		outCtx.drawImage(canvas, 0, 0, samplesX * blocksPerSample * scale, samplesZ * blocksPerSample * scale)
		return out
	}

	generateTile(key: string, coords: L.Coords, worker_id: number) {
		// @ts-expect-error: _tileCoordsToBounds does not exist
		const tileBounds = this._tileCoordsToBounds(coords);
		const west = tileBounds.getWest(),
			east = tileBounds.getEast(),
			north = tileBounds.getNorth(),
			south = tileBounds.getSouth();

		const crs = this._map.options.crs!,
			min = crs.project(L.latLng(north, west)).multiplyBy(0.25),
			max = crs.project(L.latLng(south, east)).multiplyBy(0.25);

		min.y *= -1
		max.y *= -1

		const task = {
			key,
			min,
			max,
			tileSize: this.tileSize * this.calcResolution
		}

		this.workers[worker_id].postMessage({ task })
	}

	createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
		const tile = L.DomUtil.create("canvas", "leaflet-tile")
		tile.width = tile.height = this.tileSize

		tile.onselectstart = tile.onmousemove = L.Util.falseFn

		const ctx = tile.getContext("2d")!

		if (!this._map) {
			return tile;
		}

		this.datapackLoader?.then(() => {
			const key = this._tileCoordsToKey(coords)
			this.Tiles[key] = { coords: coords, canvas: tile, ctx: ctx, done: done, workerId: this.next_worker_id }

			this.generateTile(key, coords, this.next_worker_id)
			this.next_worker_id = (this.next_worker_id + 1) % WORKER_COUNT
		})

		return tile
	}

	_removeTile(key: string) {
		if (this.Tiles[key] === undefined)
			return

		this.workers[this.Tiles[key].workerId].postMessage({ cancel: key })

		delete this.Tiles[key]

		// @ts-expect-error: _removeTile does not exist
		L.TileLayer.prototype._removeTile.call(this, key)
	}

}