#!/usr/bin/env node
/**
 * rune-map CLI — three subcommands:
 *   server     boot a state server on an auto-picked port
 *   source     publish entities (JSON-lines from stdin or --input)
 *   controller read/observe entities; send commands (--interactive REPL or one-shot)
 */

import WebSocket, { type RawData } from 'ws'
import { readFileSync, existsSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { StateServer, statePath } from '../server/index.js'
import { ControllerClient } from './controller-client.js'
import type { Entity, ServerMessage } from '../core/types.js'
import { renderSceneMap } from '../core/map-renderer.js'

const STATE_DIR = '/tmp'

// === Subcommand dispatch ===

const subcommands = new Set([
    'server',
    'source',
    'controller',
    'scene',
    'map',
    'watch',
    'move',
    'toggle-rune',
    'camera-reset',
    'interact',
    'game',
    'quests',
    'inventory',
    'play',
    'repl',
    'sessions',
])
const subcommand = process.argv.slice(2).find((argument) => subcommands.has(argument)) ?? process.argv[2]
switch (subcommand) {
    case 'server':
        runServer().catch(fatal)
        break
    case 'source':
        runSource().catch(fatal)
        break
    case 'controller':
        runController().catch(fatal)
        break
    case 'scene':
        runScene().catch(fatal)
        break
    case 'map':
        runMap().catch(fatal)
        break
    case 'watch':
        runWatch().catch(fatal)
        break
    case 'move':
        runMove().catch(fatal)
        break
    case 'toggle-rune':
        runAction('toggle-rune').catch(fatal)
        break
    case 'camera-reset':
        runAction('camera-reset').catch(fatal)
        break
    case 'repl':
        runRepl().catch(fatal)
        break
    case 'sessions':
        runSessions().catch(fatal)
        break
    case 'interact':
        runAction('interact').catch(fatal)
        break
    case 'game':
        runGame().catch(fatal)
        break
    case 'quests':
        runQuests().catch(fatal)
        break
    case 'inventory':
        runInventory().catch(fatal)
        break
    case 'play':
        runPlay().catch(fatal)
        break
    case '--help':
    case '-h':
    case undefined:
        printHelp()
        break
    default:
        console.error(`Unknown subcommand: ${subcommand}`)
        printHelp()
        process.exit(1)
}

// === server ===

async function runServer(): Promise<void> {
    const opts = parseServerOpts()
    const server = await StateServer.create({ port: opts.port, slug: opts.slug })
    console.log(`[server] up on ws://localhost:${server.port}`)

    const shutdown = async () => {
        console.log('\n[server] shutting down')
        await server.stop()
        process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
}

// === source ===

async function runSource(): Promise<void> {
    const opts = parseSourceOpts()
    const ws = await connect(opts.url, opts.slug)
    const role = await register(ws, opts.namespace, 'source')
    if (role !== 'source') throw new Error('Failed to register as source')

    const stream = opts.input
        ? createReadStream(opts.input)
        : process.stdin

    ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as { type: string }
        console.log(JSON.stringify(msg))
    })

    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    let lineNo = 0
    for await (const line of rl) {
        lineNo++
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        try {
            const message = JSON.parse(trimmed) as Record<string, unknown>
            await send(ws, message)
        } catch (err) {
            console.error(`[source] invalid JSON on line ${lineNo}: ${errMessage(err)}`)
        }
    }

    ws.close()
}

// === controller ===

async function runController(): Promise<void> {
    const opts = parseControllerOpts()
    const ws = await connect(opts.url, opts.slug)
    await register(ws, opts.namespace, 'controller')

    if (opts.interactive) {
        await runInteractive(ws, opts.namespace)
        return
    }

    if (opts.watch) {
        await send(ws, { type: 'subscribe', topics: ['entities', 'commands'] })
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString())
            console.log(JSON.stringify(msg))
        })
        process.on('SIGINT', () => {
            ws.close()
            process.exit(0)
        })
        return
    }

    // Default: send snapshot request and print on response, then exit.
    let done = false
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as { type: string }
        if (msg.type === 'snapshot') {
            if (!done) {
                done = true
                console.log(JSON.stringify(msg, null, opts.pretty ? 2 : undefined))
                ws.close()
            }
        }
    })
    await send(ws, { type: 'snapshot' })
    // Safety timeout — exit if server doesn't respond.
    setTimeout(() => {
        if (!done) {
            console.error('[controller] timeout waiting for snapshot')
            process.exit(1)
        }
    }, 5000)
}

async function runInteractive(ws: WebSocket, namespace: string): Promise<void> {
    console.log(`[controller] interactive mode for namespace "${namespace}"`)
    console.log('commands: list, snapshot, subscribe [topics], unsubscribe [topics], send <kind> <json>, hold <json>, clear <id>, quit')

    ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        console.log('<', JSON.stringify(msg))
    })

    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
    for await (const line of rl) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const parts = trimmed.split(/\s+/)
        const cmd = parts[0]
        try {
            switch (cmd) {
                case 'list':
                case 'snapshot':
                    await send(ws, { type: cmd })
                    break
                case 'subscribe':
                case 'unsubscribe': {
                    const topics = parts.slice(1) as Array<'entities' | 'commands'>
                    await send(ws, { type: cmd, topics })
                    break
                }
                case 'send':
                case 'hold': {
                    const kind: 'one-shot' | 'active' = cmd === 'send' ? 'one-shot' : 'active'
                    const payloadJson = parts.slice(1).join(' ')
                    const payload = payloadJson ? (JSON.parse(payloadJson) as Record<string, unknown>) : {}
                    await send(ws, { type: 'command', kind, payload })
                    break
                }
                case 'clear':
                    await send(ws, { type: 'clearCommand', id: parts[1] ?? '' })
                    break
                case 'quit':
                case 'exit':
                    ws.close()
                    process.exit(0)
                default:
                    console.error(`[controller] unknown command: ${cmd}`)
            }
        } catch (err) {
            console.error(`[controller] error: ${errMessage(err)}`)
        }
    }
}

// === High-level current-source CLI ===

async function runSessions(): Promise<void> {
    const slug = option('--slug') ?? option('--namespace')
    if (!slug) throw new Error('--slug <slug> is required')
    const client = new ControllerClient({
        namespace: slug,
        url: resolveUrl(slug, option('--url')),
    })
    try {
        await client.connect()
        const prefix = `${slug}:`
        const namespaces = await client.namespaces()
        console.log(JSON.stringify(namespaces
            .filter((namespace) => namespace.startsWith(prefix))
            .map((namespace) => ({
                sessionName: namespace.slice(prefix.length),
                namespace,
            })), null, 2))
    } finally {
        client.close()
    }
}

interface SceneSnapshotLike {
    timestamp?: string
    version?: string
    meta?: Record<string, unknown>
    summary?: string
    objects?: SceneObjectLike[]
    [key: string]: unknown
}

interface SceneObjectLike {
    id?: string
    name?: string
    position?: Record<string, unknown>
    [key: string]: unknown
}

interface SceneOptions {
    pretty: boolean
    summary: boolean
    object?: string
    jsonl: boolean
}

async function runScene(): Promise<void> {
    const options = parseSceneOptions()
    const client = createHighLevelClient()
    try {
        await client.connect()
        const response = await client.snapshot()
        const scene = requireScene(response.entities)
        printScene(scene, options)
    } finally {
        client.close()
    }
}

async function runMap(): Promise<void> {
    const session = option('-s') ?? option('--session')
    if (!session) throw new Error('--session <sessionName> is required')
    const client = createHighLevelClient()
    try {
        await client.connect()
        const scene = requireScene((await client.snapshot()).entities)
        console.log(renderSceneMap(scene))
    } finally {
        client.close()
    }
}

async function runWatch(): Promise<void> {
    const client = createHighLevelClient()
    const stopped = waitForShutdown(client)
    const removeHandler = client.onMessage((message) => {
        if (message.type !== 'change') return
        const scene = sceneFromEntities(message.updated ?? [])
        if (!scene) return
        console.log(JSON.stringify({
            type: 'scene-change',
            timestamp: scene.timestamp,
            summary: scene.summary,
            objects: scene.objects,
        }))
    })

    try {
        await client.connect()
        const response = await client.subscribe(['entities'])
        printScene(requireScene(response.entities), { pretty: false, summary: false, jsonl: false })
        await stopped
    } finally {
        removeHandler()
        client.close()
    }
}

async function runMove(): Promise<void> {
    const x = requiredNumber('--x')
    const z = requiredNumber('--z')
    const wait = flag('--wait')
    const client = createHighLevelClient()

    try {
        await client.connect()
        const before = requireScene((await client.snapshot()).entities)
        const beforePosition = findSceneObject(before, 'player-local')?.position
        await client.subscribe(['entities'])
        const changed = wait
            ? client.waitFor((message): message is Extract<ServerMessage, { type: 'change' }> => {
                if (message.type !== 'change') return false
                const next = sceneFromEntities(message.updated ?? [])
                const nextPosition = next ? findSceneObject(next, 'player-local')?.position : undefined
                return hasMoved(beforePosition, nextPosition)
            })
            : null
        const command = await client.command('one-shot', { action: 'move', x, z })

        if (!changed) {
            console.log(JSON.stringify({ command }, null, 2))
            return
        }

        const response = await changed
        const after = requireScene(response.updated ?? [])
        console.log(JSON.stringify({
            command,
            before: beforePosition,
            after: findSceneObject(after, 'player-local')?.position,
        }, null, 2))
    } finally {
        client.close()
    }
}

async function runAction(action: 'toggle-rune' | 'camera-reset' | 'interact'): Promise<void> {
    const client = createHighLevelClient()
    try {
        await client.connect()
        requireScene((await client.snapshot()).entities)
        const command = await client.command('one-shot', { action })
        console.log(JSON.stringify({ command }, null, 2))
    } finally {
        client.close()
    }
}

interface GameProgress {
    name?: string
    quests: Array<{ id: string; state: string; title: string; objective: string; reward: string }>
    inventory: { items: string[] }
    runes: { collected: string[]; active: string | null }
    dialogues?: Record<string, string[]>
    visited: { npcs: string[]; runes: string[]; items: string[]; gates: string[] }
    position?: { x: number; y: number; z: number }
    [key: string]: unknown
}

function findGameEntity(entities: Entity[]): GameProgress | null {
    const entity = entities.find((candidate) => candidate.id === 'game')
    if (!entity) return null
    const record = entity as Entity & { progress?: GameProgress }
    if (record.progress && typeof record.progress === 'object') return record.progress
    if (isRecord(entity.snapshot)) return entity.snapshot as unknown as GameProgress
    return null
}

function printProgress(progress: GameProgress): void {
    console.log(JSON.stringify(progress, null, 2))
}

async function runGame(): Promise<void> {
    const client = createHighLevelClient()
    try {
        await client.connect()
        const snapshot = await client.snapshot()
        const progress = findGameEntity(snapshot.entities)
        if (!progress) {
            console.log(JSON.stringify({ error: 'no game entity. Interact first to start playing.' }))
            return
        }
        printProgress(progress)
    } finally {
        client.close()
    }
}

async function runQuests(): Promise<void> {
    const client = createHighLevelClient()
    try {
        await client.connect()
        const snapshot = await client.snapshot()
        const progress = findGameEntity(snapshot.entities)
        if (!progress) {
            console.log(JSON.stringify({ quests: [] }))
            return
        }
        console.log(JSON.stringify(progress.quests ?? [], null, 2))
    } finally {
        client.close()
    }
}

async function runInventory(): Promise<void> {
    const client = createHighLevelClient()
    try {
        await client.connect()
        const snapshot = await client.snapshot()
        const progress = findGameEntity(snapshot.entities)
        if (!progress) {
            console.log(JSON.stringify({ inventory: { items: [] }, runes: { collected: [], active: null } }))
            return
        }
        console.log(JSON.stringify({
            inventory: progress.inventory ?? { items: [] },
            runes: progress.runes ?? { collected: [], active: null },
        }, null, 2))
    } finally {
        client.close()
    }
}

async function moveTo(client: ControllerClient, x: number, z: number, waitMs = 4000): Promise<void> {
    await client.subscribe(['entities'])
    await client.command('one-shot', { action: 'move', x, z })
    await new Promise((resolve) => setTimeout(resolve, waitMs))
}

async function interactAndRead(
    client: ControllerClient,
    waitMs = 600,
): Promise<{ events: Array<Record<string, unknown>>; progress: GameProgress | null }> {
    await client.subscribe(['entities'])
    await client.command('one-shot', { action: 'interact' })
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    const snapshot = await client.snapshot()
    const progress = findGameEntity(snapshot.entities)
    const events: Array<Record<string, unknown>> = []
    return { events, progress }
}

async function runPlay(): Promise<void> {
    const slug = option('--slug') ?? option('--namespace')
    const sessionName = option('--session') ?? option('-s')
    if (!slug) throw new Error('--slug <slug> is required')
    if (!sessionName) throw new Error('-s <sessionName> is required')
    validateSessionName(sessionName)

    const client = new ControllerClient({
        namespace: `${slug}:${sessionName}`,
        url: resolveUrl(slug, option('--url')),
    })
    await client.connect()

    // Smart play: drive through quest objectives based on actual game state.
    const log: Array<Record<string, unknown>> = []
    let turn = 0
    const maxTurns = 30

    type Objective = { label: string; x: number; z: number }
    const objectives: Objective[] = [
        { label: 'Мира у Поляны', x: 0, z: 2 },
        { label: 'Нима у Сломанной доски', x: -16, z: -14 },
        { label: 'Лист Сломанной доски', x: -16.5, z: -14.5 },
        { label: 'Оррин у Камня партий', x: -12, z: 5 },
        { label: 'Зеркальная руна Камня', x: -12, z: 5 },
        { label: 'Эль у Зеркального пруда', x: 18, z: 18 },
        { label: 'Отголосок у врат', x: 0, z: -34 },
        { label: 'Руна глубины пруда', x: 18, z: 18 },
        { label: 'Страж у Корневых ворот', x: 0, z: -34 },
        { label: 'Светляк в пещере', x: 0, z: -32 },
    ]

    while (turn++ < maxTurns) {
        const snapshot = await client.snapshot()
        const progress = findGameEntity(snapshot.entities)
        if (!progress) {
            console.log(`\n[play turn ${turn}] no game entity yet, going to Mira`)
            await moveTo(client, 0, 2, 2500)
            const r = await interactAndRead(client, 600)
            log.push({ turn, stage: 'init', progress: r.progress })
            continue
        }

        const activeQuests = progress.quests.filter((q) => q.state === 'active')
        const completedQuests = progress.quests.filter((q) => q.state === 'completed')
        const items = progress.inventory?.items ?? []
        const runes = progress.runes?.collected ?? []

        const status = {
            turn,
            activeQuests: activeQuests.map((q) => q.id),
            completed: completedQuests.map((q) => q.id),
            items,
            runes,
        }
        console.log(`\n[play turn ${turn}] state: ${JSON.stringify(status)}`)

        if (completedQuests.length >= 5 && runes.includes('mirror') && runes.includes('depth') && runes.includes('gate')) {
            console.log('[play] all runes collected!')
            break
        }

        // Pick next objective based on state.
        let objective: Objective | null = null
        if (!progress.visited.npcs.includes('npc-mira')) objective = objectives[0]!
        else if (!items.includes('item-leaf') && !items.includes('item-dust')) objective = objectives[1]!
        else if (items.includes('item-leaf') && !runes.includes('mirror')) objective = objectives[3]!
        else if (runes.includes('mirror') && !items.includes('item-dust')) objective = objectives[1]!
        else if (items.includes('item-dust') && runes.includes('mirror') && runes.filter((r) => r === 'mirror').length < 2) objective = objectives[3]!
        else if (!progress.visited.npcs.includes('npc-el')) objective = objectives[5]!
        else if (!items.includes('item-echo')) objective = objectives[6]!
        else if (items.includes('item-echo') && !runes.includes('depth')) objective = objectives[5]!
        else if (!runes.includes('gate')) objective = objectives[8]!
        else if (!runes.includes('wisp')) objective = objectives[9]!
        else objective = objectives[turn % objectives.length]!

        console.log(`[play] → ${objective.label} (${objective.x}, ${objective.z})`)
        await moveTo(client, objective.x, objective.z, 3500)
        const r = await interactAndRead(client, 800)
        log.push({ turn, stage: objective.label, progress: r.progress })
    }

    console.log('\n[play] === summary ===')
    console.log(JSON.stringify(log, null, 2))
    client.close()
}

async function runRepl(): Promise<void> {
    const client = createHighLevelClient()
    await client.connect()
    const initial = await client.subscribe(['entities', 'commands'])
    console.log(JSON.stringify({ ready: true, scene: requireScene(initial.entities).summary }))
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

    try {
        for await (const line of rl) {
            const parts = line.trim().split(/\\s+/)
            const command = parts.shift()
            if (!command) continue
            if (command === 'quit' || command === 'exit') break
            if (command === 'scene' || command === 'summary') {
                const scene = requireScene((await client.snapshot()).entities)
                printScene(scene, { pretty: command === 'scene', summary: command === 'summary', jsonl: false })
                continue
            }
            if (command === 'move' && parts.length === 2) {
                const x = parseFiniteNumber(parts[0], 'move x')
                const z = parseFiniteNumber(parts[1], 'move z')
                const before = requireScene((await client.snapshot()).entities)
                const beforePosition = findSceneObject(before, 'player-local')?.position
                const changed = client.waitFor((message): message is Extract<ServerMessage, { type: 'change' }> => {
                    if (message.type !== 'change') return false
                    const next = sceneFromEntities(message.updated ?? [])
                    return hasMoved(beforePosition, next ? findSceneObject(next, 'player-local')?.position : undefined)
                })
                await client.command('one-shot', { action: 'move', x, z })
                const after = requireScene((await changed).updated ?? [])
                console.log(JSON.stringify({ before: beforePosition, after: findSceneObject(after, 'player-local')?.position }))
                continue
            }
            if (command === 'toggle-rune' || command === 'camera-reset' || command === 'interact') {
                const issued = await client.command('one-shot', { action: command })
                console.log(JSON.stringify({ command: issued }))
                continue
            }
            if (command === 'game' || command === 'quests' || command === 'inventory') {
                const snapshot = await client.snapshot()
                const progress = findGameEntity(snapshot.entities)
                if (!progress) {
                    console.log(JSON.stringify({ note: 'no game entity yet — interact first' }))
                    continue
                }
                if (command === 'game') console.log(JSON.stringify(progress, null, 2))
                else if (command === 'quests') console.log(JSON.stringify(progress.quests ?? [], null, 2))
                else console.log(JSON.stringify({ inventory: progress.inventory, runes: progress.runes }, null, 2))
                continue
            }
            console.error('commands: scene, summary, move <x> <z>, toggle-rune, camera-reset, interact, game, quests, inventory, quit')
        }
    } finally {
        rl.close()
        client.close()
    }
}

function createHighLevelClient(): ControllerClient {
    const slug = option('--slug') ?? option('--namespace')
    const sessionName = option('--session') ?? option('-s')
    if (!slug) throw new Error('--slug <slug> is required')
    if (!sessionName) throw new Error('-s <sessionName> is required')
    validateSessionName(sessionName)

    return new ControllerClient({
        namespace: `${slug}:${sessionName}`,
        url: resolveUrl(slug, option('--url')),
    })
}

function validateSessionName(sessionName: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sessionName)) {
        throw new Error('sessionName must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}')
    }
}

function parseSceneOptions(): SceneOptions {
    return {
        pretty: flag('--pretty'),
        summary: flag('--summary'),
        object: option('--object'),
        jsonl: flag('--jsonl'),
    }
}

function printScene(scene: SceneSnapshotLike, options: SceneOptions): void {
    if (options.summary) {
        console.log(scene.summary ?? '')
        return
    }
    if (options.object) {
        console.log(JSON.stringify(findSceneObject(scene, options.object), null, options.pretty ? 2 : undefined))
        return
    }
    if (options.jsonl) {
        for (const object of scene.objects ?? []) console.log(JSON.stringify(object))
        return
    }
    console.log(JSON.stringify(scene, null, options.pretty ? 2 : undefined))
}

function requireScene(entities: Entity[]): SceneSnapshotLike {
    const scene = sceneFromEntities(entities)
    if (!scene) throw new Error('Current browser source is not connected or scene entity is unavailable')
    return scene
}

function sceneFromEntities(entities: Entity[]): SceneSnapshotLike | null {
    const entity = entities.find((candidate) => candidate.id === 'scene')
    return isRecord(entity?.snapshot) ? entity.snapshot as SceneSnapshotLike : null
}

function findSceneObject(scene: SceneSnapshotLike, selector: string): SceneObjectLike | undefined {
    return (scene.objects ?? []).find((object) => object.id === selector || object.name === selector)
}

function hasMoved(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): boolean {
    if (!before || !after) return false
    const beforeX = finiteRecordNumber(before, 'x')
    const beforeZ = finiteRecordNumber(before, 'z')
    const afterX = finiteRecordNumber(after, 'x')
    const afterZ = finiteRecordNumber(after, 'z')
    if (beforeX === null || beforeZ === null || afterX === null || afterZ === null) return false
    return Math.hypot(afterX - beforeX, afterZ - beforeZ) > 0.1
}

function requiredNumber(name: string): number {
    return parseFiniteNumber(option(name), name)
}

function parseFiniteNumber(value: string | undefined, name: string): number {
    const parsed = Number(value)
    if (!value || !Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`)
    return parsed
}

function finiteRecordNumber(record: Record<string, unknown>, key: string): number | null {
    const value = record[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function waitForShutdown(client: ControllerClient): Promise<void> {
    return new Promise((resolve) => {
        const stop = (): void => {
            process.off('SIGINT', stop)
            process.off('SIGTERM', stop)
            resolve()
        }
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
    })
}

// === Connection helpers ===

interface BaseOpts {
    url?: string
    slug?: string
    namespace: string
}

function resolveUrl(slug?: string, url?: string): string {
    if (url) return url
    if (slug) {
        const path = statePath(slug)
        if (!existsSync(path)) {
            throw new Error(`no RuneMap server found for slug "${slug}" (expected ${path})`)
        }
        const port = readFileSync(join(STATE_DIR, `${slug}.rune.port`), 'utf-8').trim()
        return `ws://localhost:${port}`
    }
    return 'ws://localhost:3002'
}

function connect(url: string | undefined, slug: string | undefined): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const finalUrl = resolveUrl(slug, url)
        const ws = new WebSocket(finalUrl)
        ws.once('open', () => resolve(ws))
        ws.once('error', (err) => reject(err))
    })
}

function register(ws: WebSocket, namespace: string, role: 'source' | 'controller'): Promise<'source' | 'controller'> {
    return new Promise((resolve, reject) => {
        const onMessage = (raw: RawData) => {
            const msg = JSON.parse(raw.toString()) as { type: string; role?: string }
            if (msg.type === 'ready' && msg.role === role) {
                ws.off('message', onMessage)
                resolve(role)
            } else if (msg.type === 'error') {
                ws.off('message', onMessage)
                reject(new Error(`registration failed: ${(msg as { message?: string }).message ?? 'unknown'}`))
            }
        }
        ws.on('message', onMessage)
        ws.send(JSON.stringify({ type: 'register', role, namespace }))
    })
}

function send(ws: WebSocket, message: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
        ws.send(JSON.stringify(message), (err) => {
            if (err) reject(err)
            else resolve()
        })
    })
}

// === Arg parsing ===

function flag(name: string): boolean {
    return process.argv.includes(name)
}

function option(name: string): string | undefined {
    const idx = process.argv.indexOf(name)
    if (idx === -1) return undefined
    return process.argv[idx + 1]
}

function requireNamespace(restArgs: string[]): string {
    const ns = option('--namespace') ?? option('-n')
    if (!ns) {
        throw new Error('--namespace <slug> is required. Args: ' + restArgs.join(' '))
    }
    return ns
}

interface ServerOpts { port?: number; slug?: string }

function parseServerOpts(): ServerOpts {
    const portStr = option('--port') ?? option('-p')
    return {
        port: portStr ? parseInt(portStr, 10) : undefined,
        slug: option('--namespace') ?? option('-n'),
    }
}

interface SourceOpts extends BaseOpts { input?: string }

function parseSourceOpts(): SourceOpts {
    const namespace = requireNamespace(process.argv.slice(3))
    return {
        namespace,
        url: option('--url'),
        slug: option('--slug') ?? namespace,
        input: option('--input') ?? option('-i'),
    }
}

interface ControllerOpts extends BaseOpts { watch: boolean; interactive: boolean; pretty: boolean }

function parseControllerOpts(): ControllerOpts {
    const namespace = requireNamespace(process.argv.slice(3))
    return {
        namespace,
        url: option('--url'),
        slug: option('--slug') ?? namespace,
        watch: flag('--watch') || flag('-w'),
        interactive: flag('--interactive') || flag('-i'),
        pretty: flag('--pretty') || flag('-p'),
    }
}

// === Misc ===

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

function fatal(err: unknown): void {
    console.error('[rune-map]', errMessage(err))
    process.exit(1)
}

function printHelp(): void {
    console.log(`rune-map — in-memory state server CLI

Usage:
  rune-map server   [--port N] [--namespace <slug>]
  rune-map source   --namespace <slug> [--slug <slug>] [--url <ws>] [--input <file>]
  rune-map controller --namespace <slug> [--watch|--interactive|--pretty]
                     [--slug <slug>] [--url <ws>]
  rune-map scene     --slug <slug> -s <sessionName> [--pretty|--summary|--jsonl|--object <id-or-name>]
  rune-map map       --slug <slug> -s <sessionName>
  rune-map watch     --slug <slug> -s <sessionName>
  rune-map move      --slug <slug> -s <sessionName> --x <number> --z <number> [--wait]
  rune-map toggle-rune  --slug <slug> -s <sessionName>
  rune-map camera-reset --slug <slug> -s <sessionName>
  rune-map interact  --slug <slug> -s <sessionName>
  rune-map game      --slug <slug> -s <sessionName>
  rune-map quests    --slug <slug> -s <sessionName>
  rune-map inventory --slug <slug> -s <sessionName>
  rune-map play      --slug <slug> -s <sessionName>
  rune-map repl      --slug <slug> -s <sessionName>
  rune-map sessions  --slug <slug>

Examples:
  rune-map server --namespace demo
  echo '{"type":"put","entities":[{"id":"p1","hp":100}]}' | rune-map source --namespace demo
  rune-map controller --namespace demo --watch
  rune-map scene --slug between-worlds -s session-a1b2c3d4 --summary
  rune-map move --slug between-worlds -s session-a1b2c3d4 --x 1 --z -2 --wait
  rune-map interact --slug between-worlds -s session-a1b2c3d4
  rune-map play --slug between-worlds -s session-a1b2c3d4
  rune-map sessions --slug between-worlds

Read commands (interactive):
  list | snapshot
  subscribe entities commands | unsubscribe entities
  send one-shot {"key":"space"}
  hold {"key":"w"}
  clear <commandId>
  quit

Current-source commands never start a browser or register a new source.
The game generates sessionName when creating the local player; -s selects that session.`)
}
