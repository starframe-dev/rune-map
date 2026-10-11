/**
 * rune-map core — types + in-memory store.
 */

export type {
    Entity,
    Command,
    CommandKind,
    EntityPatch,
    Topic,
    Role,
    Subscription,
    ClientMessage,
    ServerMessage,
    ErrorCode,
    PutResult,
    DeleteResult,
    PatchResult,
    MessageSink,
    NamespaceState,
} from './types.js'

export { NamespaceStore } from './store.js'
export { renderSceneMap } from './map-renderer.js'
export type {
    MapBounds,
    MapRenderOptions,
    MapScene,
    MapSceneObject,
    MapTerrain,
    MapTerrainSurface,
    MapTerrainVolume,
    MapVec3,
} from './map-renderer.js'
