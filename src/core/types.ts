/**
 * rune-map — In-memory state-server protocol types.
 *
 * Multi-tenant: one server, many namespaces (slugs). Each namespace holds
 * arbitrary JSON entities and a set of active commands. Two client roles:
 *   - source: writes entities, receives commands
 *   - controller: reads entities + subscribes to deltas, issues commands
 */

/** Any JSON-serializable entity. `id` is required and treated as primary key. */
export interface Entity {
    id: string
    [key: string]: unknown
}

/** Operation kind for a command. */
export type CommandKind = 'one-shot' | 'active'

/**
 * Command = single input action emitted by a controller and consumed by a source.
 * - `one-shot`: fire-and-forget (e.g. mouse click, key tap). Not stored.
 * - `active`: sticky; stored in `activeCommands` until explicitly cleared.
 */
export interface Command {
    id: string
    kind: CommandKind
    target?: string
    payload: Record<string, unknown>
    issuedAt: string
}

/** Patch operation for partial entity updates. */
export interface EntityPatch {
    id: string
    /** Field values to set/merge. */
    set?: Record<string, unknown>
    /** Field names to remove. */
    unset?: string[]
}

/** Topic names that can be subscribed to. */
export type Topic = 'entities' | 'commands'

/** Roles a WebSocket client may take inside a namespace. */
export type Role = 'source' | 'controller'

/** Subscription set held per (socket, namespace). */
export interface Subscription {
    socket: import('ws').WebSocket
    topics: Set<Topic>
}

// === Client → Server messages ===

export type ClientMessage =
    | { type: 'register'; role: Role; namespace: string }
    | { type: 'put'; entities: Entity[] }
    | { type: 'patch'; updates: EntityPatch[] }
    | { type: 'delete'; ids: string[] }
    | { type: 'list' }
    | { type: 'get'; ids: string[] }
    | { type: 'command'; kind: CommandKind; payload: Record<string, unknown>; target?: string }
    | { type: 'clearCommand'; id: string }
    | { type: 'subscribe'; topics: Topic[] }
    | { type: 'unsubscribe'; topics: Topic[] }
    | { type: 'snapshot' }
    | { type: 'namespaces' }

// === Server → Client messages ===

export type ServerMessage =
    | { type: 'ready'; namespace: string; role: Role }
    | { type: 'snapshot'; entities: Entity[]; activeCommands: Command[] }
    | { type: 'change'; added?: Entity[]; updated?: Entity[]; removed?: string[] }
    | { type: 'command'; cmd: Command }
    | { type: 'commandCleared'; id: string }
    | { type: 'error'; code: string; message: string }
    | { type: 'namespaces'; namespaces: string[] }

/** Error codes used by the server. */
export type ErrorCode =
    | 'NOT_REGISTERED'
    | 'INVALID_MESSAGE'
    | 'UNKNOWN_NAMESPACE'
    | 'WRONG_ROLE'
    | 'UNKNOWN_ENTITY'
    | 'NO_SOURCE'
    | 'INTERNAL'

/** Result of a `put` batch — surfaced for tests + diagnostics. */
export interface PutResult {
    added: Entity[]
    updated: Entity[]
}

/** Result of a `delete` batch — surfaced for tests + diagnostics. */
export interface DeleteResult {
    removed: string[]
}

/** Result of a `patch` batch. */
export interface PatchResult {
    updated: Entity[]
}

/** Sink abstraction so the store can broadcast without coupling to `ws`. */
export interface MessageSink {
    send(message: ServerMessage): void
    close(): void
}

/** Pure namespace state — exposed for inspection and tests. */
export interface NamespaceState {
    entities: Map<string, Entity>
    activeCommands: Map<string, Command>
    entityCount: number
    activeCommandCount: number
}
