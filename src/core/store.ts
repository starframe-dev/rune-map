import { randomUUID } from 'node:crypto'
import type {
    Entity,
    Command,
    CommandKind,
    EntityPatch,
    Topic,
    Role,
    ServerMessage,
    MessageSink,
    NamespaceState,
    PutResult,
    DeleteResult,
    PatchResult,
} from './types.js'

const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Per-namespace runtime state held by the store.
 * Sinks are the transport-agnostic outbound channels.
 */
interface NamespaceRuntime {
    entities: Map<string, Entity>
    activeCommands: Map<string, Command>
    /** Single active source sink (graceful takeover replaces it). */
    source?: MessageSink
    controllers: Set<MessageSink>
    /** Per-sink subscription set (entities / commands). */
    subscriptions: Map<MessageSink, Set<Topic>>
}

/**
 * In-memory multi-tenant store for the rune-map server.
 *
 * Holds namespaces independently. Provides pure operations
 * (put/patch/delete/get/list) and broadcast hooks that take
 * `MessageSink` — decoupled from any specific transport.
 */
export class NamespaceStore {
    private namespaces = new Map<string, NamespaceRuntime>()

    /** Lazily create a namespace runtime. */
    private ns(namespace: string): NamespaceRuntime {
        let runtime = this.namespaces.get(namespace)
        if (!runtime) {
            runtime = {
                entities: new Map(),
                activeCommands: new Map(),
                controllers: new Set(),
                subscriptions: new Map(),
            }
            this.namespaces.set(namespace, runtime)
        }
        return runtime
    }

    /** Snapshot of a namespace for inspection/tests. */
    inspect(namespace: string): NamespaceState | null {
        const runtime = this.namespaces.get(namespace)
        if (!runtime) return null
        return {
            entities: new Map(runtime.entities),
            activeCommands: new Map(runtime.activeCommands),
            entityCount: runtime.entities.size,
            activeCommandCount: runtime.activeCommands.size,
        }
    }

    /** Names of all currently-known namespaces. */
    namespaces_(): string[] {
        return Array.from(this.namespaces.keys())
    }

    // === Registration ===

    /**
     * Register a sink in a namespace with the given role.
     * For `source`: replaces the existing source (graceful takeover — old is closed).
     * Returns true if this sink is the active source after registration
     * (false if it was a controller).
     */
    register(namespace: string, role: Role, sink: MessageSink): boolean {
        const runtime = this.ns(namespace)
        if (role === 'source') {
            if (runtime.source && runtime.source !== sink) {
                // Graceful takeover — close the previous source.
                try {
                    runtime.source.close()
                } catch {
                    // ignore — best effort
                }
            }
            runtime.source = sink
            runtime.subscriptions.set(sink, new Set(['entities', 'commands']))
            return true
        }
        runtime.controllers.add(sink)
        runtime.subscriptions.set(sink, new Set())
        return false
    }

    /** Remove a sink (called on disconnect). */
    unregister(sink: MessageSink): void {
        for (const [namespace, runtime] of this.namespaces) {
            if (runtime.source === sink) {
                runtime.source = undefined
                runtime.subscriptions.delete(sink)
                // Active commands are cleared because no source consumes them.
                if (runtime.activeCommands.size > 0) {
                    runtime.activeCommands.clear()
                }
                // Drop empty namespaces so memory doesn't leak.
                if (
                    runtime.entities.size === 0 &&
                    runtime.controllers.size === 0 &&
                    !runtime.source
                ) {
                    this.namespaces.delete(namespace)
                }
                continue
            }
            if (runtime.controllers.delete(sink)) {
                runtime.subscriptions.delete(sink)
                if (
                    runtime.entities.size === 0 &&
                    runtime.activeCommands.size === 0 &&
                    runtime.controllers.size === 0 &&
                    !runtime.source
                ) {
                    this.namespaces.delete(namespace)
                }
                continue
            }
        }
    }

    // === Entity operations (source role only) ===

    /** Bulk insert / overwrite entities. Returns added vs updated buckets. */
    putEntities(namespace: string, entities: Entity[]): PutResult {
        const runtime = this.ns(namespace)
        const added: Entity[] = []
        const updated: Entity[] = []
        for (const entity of entities) {
            if (typeof entity.id !== 'string' || entity.id.length === 0) {
                throw new Error('Entity must have a non-empty string id')
            }
            const existed = runtime.entities.has(entity.id)
            if (existed) updated.push(entity)
            else added.push(entity)
            runtime.entities.set(entity.id, entity)
        }
        if (added.length || updated.length) {
            this.broadcastChange(runtime, { added, updated })
        }
        return { added, updated }
    }

    /** Apply partial patches (merge fields, optionally remove keys). */
    patchEntities(namespace: string, updates: EntityPatch[]): PatchResult {
        const runtime = this.ns(namespace)
        const updated: Entity[] = []
        for (const patch of updates) {
            const existing = runtime.entities.get(patch.id)
            if (!existing) continue
            const merged: Entity = { ...existing }
            if (patch.set && isObject(patch.set)) {
                for (const [k, v] of Object.entries(patch.set)) {
                    merged[k] = v
                }
            }
            if (patch.unset) {
                for (const key of patch.unset) {
                    if (key !== 'id') delete merged[key]
                }
            }
            runtime.entities.set(patch.id, merged)
            updated.push(merged)
        }
        if (updated.length) {
            this.broadcastChange(runtime, { updated })
        }
        return { updated }
    }

    /** Bulk remove entities by id. */
    deleteEntities(namespace: string, ids: string[]): DeleteResult {
        const runtime = this.ns(namespace)
        const removed: string[] = []
        for (const id of ids) {
            if (runtime.entities.delete(id)) removed.push(id)
        }
        if (removed.length) {
            this.broadcastChange(runtime, { removed })
        }
        return { removed }
    }

    // === Read operations (controller role only) ===

    /** List all entities in a namespace. */
    listEntities(namespace: string): Entity[] {
        const runtime = this.namespaces.get(namespace)
        if (!runtime) return []
        return Array.from(runtime.entities.values())
    }

    /** Get a subset of entities by id. Missing ids are silently skipped. */
    getEntities(namespace: string, ids: string[]): Entity[] {
        const runtime = this.namespaces.get(namespace)
        if (!runtime) return []
        const out: Entity[] = []
        for (const id of ids) {
            const entity = runtime.entities.get(id)
            if (entity) out.push(entity)
        }
        return out
    }

    /** Build a full snapshot payload. */
    snapshot(namespace: string): { entities: Entity[]; activeCommands: Command[] } {
        return {
            entities: this.listEntities(namespace),
            activeCommands: Array.from(
                (this.namespaces.get(namespace)?.activeCommands.values() ?? [])
            ),
        }
    }

    // === Commands ===

    /** Issue a command. `active` commands are stored; `one-shot` are not. */
    issueCommand(
        namespace: string,
        args: {
            kind: CommandKind
            payload: Record<string, unknown>
            target?: string
        }
    ): Command {
        const runtime = this.ns(namespace)
        const cmd: Command = {
            id: randomUUID(),
            kind: args.kind,
            payload: args.payload,
            target: args.target,
            issuedAt: new Date().toISOString(),
        }
        if (cmd.kind === 'active') {
            runtime.activeCommands.set(cmd.id, cmd)
        }
        this.broadcastCommand(runtime, cmd)
        return cmd
    }

    /** Clear an active command by id. Returns true if removed. */
    clearCommand(namespace: string, commandId: string): boolean {
        const runtime = this.namespaces.get(namespace)
        if (!runtime) return false
        const had = runtime.activeCommands.delete(commandId)
        if (had) {
            this.broadcastMessage(runtime, 'commands', {
                type: 'commandCleared',
                id: commandId,
            })
        }
        return had
    }

    // === Subscriptions ===

    /** Add topic subscriptions for a sink. Returns the resulting topic set. */
    subscribe(sink: MessageSink, namespace: string, topics: Topic[]): Set<Topic> {
        const runtime = this.ns(namespace)
        const set = runtime.subscriptions.get(sink)
        if (!set) return new Set()
        for (const topic of topics) set.add(topic)
        return new Set(set)
    }

    /** Remove topic subscriptions for a sink. */
    unsubscribe(sink: MessageSink, namespace: string, topics: Topic[]): Set<Topic> {
        const runtime = this.ns(namespace)
        const set = runtime.subscriptions.get(sink)
        if (!set) return new Set()
        for (const topic of topics) set.delete(topic)
        return new Set(set)
    }

    // === Broadcast helpers ===

    /**
     * Broadcast an entity change (added/updated/removed) to subscribers.
     * Source always sees entity changes; controllers only if subscribed.
     */
    private broadcastChange(
        runtime: NamespaceRuntime,
        change: { added?: Entity[]; updated?: Entity[]; removed?: string[] }
    ): void {
        const message: ServerMessage = {
            type: 'change',
            added: change.added?.length ? change.added : undefined,
            updated: change.updated?.length ? change.updated : undefined,
            removed: change.removed?.length ? change.removed : undefined,
        }
        this.broadcastMessage(runtime, 'entities', message)
    }

    /** Broadcast a command to the source + command-subscribed controllers. */
    private broadcastCommand(runtime: NamespaceRuntime, cmd: Command): void {
        this.broadcastMessage(runtime, 'commands', { type: 'command', cmd })
    }

    /**
     * Dispatch a server message to all sinks subscribed to the topic.
     * The source is included by default (its subscription set contains every topic).
     */
    private broadcastMessage(
        runtime: NamespaceRuntime,
        topic: Topic,
        message: ServerMessage
    ): void {
        if (runtime.source) {
            this.safeSend(runtime.source, message)
        }
        for (const [sink, topics] of runtime.subscriptions) {
            if (sink === runtime.source) continue
            if (!topics.has(topic)) continue
            this.safeSend(sink, message)
        }
    }

    /** Send a message to a single sink, swallowing transport errors. */
    private safeSend(sink: MessageSink, message: ServerMessage): void {
        try {
            sink.send(message)
        } catch (err) {
            // Swallow — a broken sink should not break the store.
            // The transport layer is responsible for cleanup.
            void err
        }
    }
}
