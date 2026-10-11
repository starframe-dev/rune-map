import { describe, expect, it } from 'vitest'
import { renderSceneMap } from '../src/core/map-renderer.js'

function scene() {
    return {
        meta: {
            bounds: {
                min: { x: -10, y: 0, z: -10 },
                max: { x: 10, y: 5, z: 10 },
            },
        },
        objects: [
            {
                id: 'terrain',
                kind: 'terrain',
                name: 'terrain',
                terrain: {
                    surfaces: [{
                        id: 'ground',
                        kind: 'ground',
                        origin: { x: -10, y: 0, z: -10 },
                        size: { x: 20, z: 20 },
                        heights: [[0, 1], [2, 3]],
                        color: '#547a4d',
                    }],
                    volumes: [{
                        id: 'root-bridge',
                        operation: 'union' as const,
                        origin: { x: -8, y: 0, z: -2 },
                        size: { x: 16, y: 5, z: 4 },
                        color: '#806044',
                    }],
                },
            },
            {
                id: 'player-local',
                kind: 'player',
                name: 'player-local',
                position: { x: 0, y: 1, z: 0 },
            },
        ],
    }
}

describe('renderSceneMap', () => {
    it('renders terrain, volumes, players and legend as ASCII map', () => {
        const map = renderSceneMap(scene())

        expect(map).toContain('RuneMap top-down map')
        expect(map).toContain('B=root-bridge')
        expect(map).toContain('@=player-local')
        expect(map).toContain('ground height')
        expect(map).toContain('north (-Z)')
    })

    it('keeps configurable compact dimensions', () => {
        const map = renderSceneMap(scene(), { columns: 12, rows: 8 })
        const mapLines = map.split('\n').filter((line) => line.startsWith('│'))

        expect(mapLines).toHaveLength(8)
        expect(mapLines[0]).toHaveLength(14)
    })
})
