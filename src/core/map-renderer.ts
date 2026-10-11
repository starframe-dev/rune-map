export interface MapVec3 {
    x: number
    y: number
    z: number
}

export interface MapBounds {
    min: MapVec3
    max: MapVec3
}

export interface MapTerrainSurface {
    id: string
    kind: string
    origin: MapVec3
    size: { x: number; z: number }
    heights?: number[][]
    color?: string
}

export interface MapTerrainVolume {
    id: string
    operation: 'union' | 'subtract'
    origin: MapVec3
    size: MapVec3
    color?: string
}

export interface MapTerrain {
    surfaces?: MapTerrainSurface[]
    volumes?: MapTerrainVolume[]
}

export interface MapSceneObject {
    id?: string
    kind?: string
    name?: string
    position?: Partial<MapVec3>
    bounds?: MapBounds
    terrain?: MapTerrain
}

export interface MapScene {
    meta?: { bounds?: MapBounds }
    objects?: MapSceneObject[]
}

export interface MapRenderOptions {
    columns?: number
    rows?: number
}

interface MapRect {
    minX: number
    maxX: number
    minZ: number
    maxZ: number
}

const DEFAULT_COLUMNS = 64
const DEFAULT_ROWS = 32
const DEFAULT_BOUNDS: MapRect = { minX: -40, maxX: 40, minZ: -40, maxZ: 40 }

/** Render a compact top-down ASCII map for terminal and LLM inspection. */
export function renderSceneMap(scene: MapScene, options: MapRenderOptions = {}): string {
    const columns = Math.max(8, Math.floor(options.columns ?? DEFAULT_COLUMNS))
    const rows = Math.max(6, Math.floor(options.rows ?? DEFAULT_ROWS))
    const terrainObject = scene.objects?.find((object) => object.terrain)
    const terrain = terrainObject?.terrain
    const bounds = getWorldBounds(scene, terrainObject, terrain)
    const grid = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ' '))
    const surface = terrain?.surfaces?.[0]
    const heights = surface?.heights ?? []
    const heightValues = heights.flat().filter(Number.isFinite)
    const minHeight = heightValues.length > 0 ? Math.min(...heightValues) : 0
    const maxHeight = heightValues.length > 0 ? Math.max(...heightValues) : 1

    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const height = sampleHeight(heights, column, row, columns, rows, minHeight)
            grid[row]![column] = heightGlyph(height, minHeight, maxHeight)
        }
    }

    for (const volume of terrain?.volumes ?? []) {
        stampRect(grid, volumeRect(volume.origin.x, volume.origin.z, volume.size.x, volume.size.z), bounds, volumeGlyph(volume.id, volume.operation))
    }

    const visibleObjects: Array<{ label: string; glyph: string }> = []
    for (const object of scene.objects ?? []) {
        if (object.terrain || object.kind === 'light' || object.kind === 'camera' || object.kind === 'helper') continue
        const position = object.position ?? centerOf(object.bounds)
        if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) continue
        const glyph = objectGlyph(object)
        const x = numberOr(position.x, 0)
        const z = numberOr(position.z, 0)
        stampPoint(grid, x, z, bounds, glyph)
        visibleObjects.push({ label: object.name ?? object.id ?? 'object', glyph })
    }

    const lines = grid.map((line) => `│${line.join('')}│`)
    const legend = Array.from(new Map(visibleObjects.map((object) => [object.glyph, `${object.glyph}=${object.label}`])).values())
    const volumeLegend = (terrain?.volumes ?? []).map((volume) => `${volumeGlyph(volume.id, volume.operation)}=${volume.id}`).join(' ')
    const objectLegend = legend.join(' ')
    return [
        `RuneMap top-down map  X:[${format(bounds.minX)},${format(bounds.maxX)}] Z:[${format(bounds.minZ)},${format(bounds.maxZ)}]`,
        `┌${'─'.repeat(columns)}┐`,
        ...lines,
        `└${'─'.repeat(columns)}┘`,
        `north (-Z) ↑   south (+Z) ↓   west (-X) ←   east (+X) →`,
        `ground height: ${format(minHeight)}..${format(maxHeight)}  ${heightLegend()}`,
        volumeLegend ? `volumes: ${volumeLegend}` : '',
        objectLegend ? `objects: ${objectLegend}` : '',
    ].filter((line) => line.length > 0).join('\n')
}

function getWorldBounds(scene: MapScene, terrainObject: MapSceneObject | undefined, terrain: MapTerrain | undefined): MapRect {
    const surface = terrain?.surfaces?.[0]
    if (surface) {
        return {
            minX: surface.origin.x,
            maxX: surface.origin.x + surface.size.x,
            minZ: surface.origin.z,
            maxZ: surface.origin.z + surface.size.z,
        }
    }
    const source = terrainObject?.bounds ?? scene.meta?.bounds
    if (source) {
        return { minX: source.min.x, maxX: source.max.x, minZ: source.min.z, maxZ: source.max.z }
    }
    return DEFAULT_BOUNDS
}

function volumeRect(x: number, z: number, width: number, depth: number): MapRect {
    return { minX: x, maxX: x + width, minZ: z, maxZ: z + depth }
}

function stampRect(grid: string[][], rect: MapRect, bounds: MapRect, glyph: string): void {
    const minColumn = worldToColumn(rect.minX, bounds, grid[0]!.length)
    const maxColumn = worldToColumn(rect.maxX, bounds, grid[0]!.length)
    const minRow = worldToRow(rect.maxZ, bounds, grid.length)
    const maxRow = worldToRow(rect.minZ, bounds, grid.length)
    for (let row = minRow; row <= maxRow; row++) {
        for (let column = minColumn; column <= maxColumn; column++) {
            if (grid[row]?.[column] !== undefined) grid[row]![column] = glyph
        }
    }
}

function stampPoint(grid: string[][], x: number, z: number, bounds: MapRect, glyph: string): void {
    const column = worldToColumn(x, bounds, grid[0]!.length)
    const row = worldToRow(z, bounds, grid.length)
    if (grid[row]?.[column] !== undefined) grid[row]![column] = glyph
}

function worldToColumn(x: number, bounds: MapRect, columns: number): number {
    return clamp(Math.floor(((x - bounds.minX) / (bounds.maxX - bounds.minX)) * columns), 0, columns - 1)
}

function worldToRow(z: number, bounds: MapRect, rows: number): number {
    return clamp(Math.floor(((bounds.maxZ - z) / (bounds.maxZ - bounds.minZ)) * rows), 0, rows - 1)
}

function sampleHeight(heights: number[][], column: number, row: number, columns: number, rows: number, fallback: number): number {
    if (heights.length === 0 || (heights[0]?.length ?? 0) === 0) return fallback
    const sourceRow = clamp(Math.floor((row / rows) * heights.length), 0, heights.length - 1)
    const sourceColumn = clamp(Math.floor((column / columns) * heights[0]!.length), 0, heights[0]!.length - 1)
    return heights[sourceRow]?.[sourceColumn] ?? fallback
}

function heightGlyph(value: number, min: number, max: number): string {
    const glyphs = '.,:;irsXA253hMHGS#9B&@'
    const ratio = max === min ? 0 : (value - min) / (max - min)
    return glyphs[clamp(Math.floor(ratio * glyphs.length), 0, glyphs.length - 1)]!
}

function heightLegend(): string {
    return '. low → @ high'
}

function volumeGlyph(id: string, operation: 'union' | 'subtract'): string {
    if (operation === 'subtract') return 'x'
    if (id.includes('bridge')) return 'B'
    if (id.includes('ramp')) return 'R'
    if (id.includes('cave')) return 'C'
    return 'V'
}

function objectGlyph(object: MapSceneObject): string {
    if (object.kind === 'player') return object.name?.includes('local') || object.id === 'player-local' ? '@' : 'p'
    if (object.kind === 'obstacle') return 'O'
    const name = `${object.id ?? ''} ${object.name ?? ''}`.toLowerCase()
    if (name.includes('rune')) return 'R'
    if (name.includes('gate')) return 'G'
    if (name.includes('item')) return 'I'
    if (name.includes('npc')) return 'N'
    return '*'
}

function numberOr(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function centerOf(bounds: MapBounds | undefined): MapVec3 | null {
    if (!bounds) return null
    return {
        x: (bounds.min.x + bounds.max.x) / 2,
        y: (bounds.min.y + bounds.max.y) / 2,
        z: (bounds.min.z + bounds.max.z) / 2,
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value))
}

function format(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
