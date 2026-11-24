export type NodeType = 'station' | 'terminal' | 'depot' | 'waypoint'
export type LineKind = 'line' | 'service'
export type TrackType = 'single' | 'double'

export const NAMED_NODE_TYPES: NodeType[] = ['station', 'terminal', 'depot']

export type RailNode = {
    id: string
    type: NodeType
    /** block x coordinate */
    x: number
    /** block z coordinate */
    z: number
    name: string
    /** free text: e.g. "Nether portal, Village" */
    integrations: string
    notes: string
}

export type RailLine = {
    id: string
    name: string
    /** short code shown in badges, e.g. "1", "A", "L2" */
    code: string
    color: string
    kind: LineKind
    /** ordered list of node ids forming the track path */
    nodeIds: string[]
}

export type RailTransfer = {
    id: string
    a: string
    b: string
}

export type WorldSettings = {
    seed: string
    mc_version: string
    world_preset: string
    dimension: string
    datapacks: string[]
}

export type RailProject = {
    format: 1
    id: string
    title: string
    subtitle: string
    createdAt: number
    updatedAt: number
    world: WorldSettings
    settings: {
        /** blocks per second used for travel time estimates */
        trainSpeed: number
        /** track type given to newly drawn track */
        newTrack: TrackType
    }
    /** segment keys (see segmentKey) of single-track sections; every other section is double track */
    singleTrack: string[]
    nodes: RailNode[]
    lines: RailLine[]
    transfers: RailTransfer[]
}

export type ProjectSummary = {
    id: string
    title: string
    updatedAt: number
    seed: string
    stations: number
    lines: number
}

export type Tool = 'select' | 'track' | 'tracktype' | 'station' | 'terminal' | 'depot' | 'transfer' | 'delete'

export type Selection = { kind: 'node' | 'line' | 'transfer', id: string } | undefined
