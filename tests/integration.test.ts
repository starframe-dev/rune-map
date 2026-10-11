import { test, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import { StateServer } from '../src/server/index.js'
import type { ServerMessage } from '../src/core/types.js'

interface Harness {
    server: StateServer
    url: string
}

async function startServer(): Promise<Harness> {
    const server = await StateServer.create({ port: 0 })
    return { server, url: `ws://localhost:${server.port}` }
}

async function openSocket(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url)
        ws.once('open', () => resolve(ws))
        ws.once('error', reject)
    })
}

function once<T = ServerMessage>(
    ws: WebSocket,
    predicate: (m: ServerMessage) => boolean
): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('once: timeout')), 3000)
        const handler = (raw: WebSocket.RawData) => {
            const msg = JSON.parse(raw.toString()) as ServerMessage
            if (predicate(msg)) {
                clearTimeout(timer)
                ws.off('message', handler)
                resolve(msg as unknown as T)
            }
        }
        ws.on('message', handler)
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

async function register(
    ws: WebSocket,
    namespace: string,
    role: 'source' | 'controller'
): Promise<void> {
    const ready = once(ws, (m) => m.type === 'ready')
    await send(ws, { type: 'register', role, namespace })
    await ready
}

const harnessRef: { current?: Harness } = {}

afterEach(async () => {
    if (harnessRef.current) {
        await harnessRef.current.server.stop()
        harnessRef.current = undefined
    }
})

test('source writes entities, controller receives change deltas', async () => {
    const harness = await startServer()
    harnessRef.current = harness

    const source = await openSocket(harness.url)
    const controller = await openSocket(harness.url)

    await register(source, 'demo', 'source')
    await register(controller, 'demo', 'controller')
    await send(controller, { type: 'subscribe', topics: ['entities'] })
    await once(controller, (m) => m.type === 'snapshot')

    const changePromise = once<ServerMessage & { type: 'change' }>(
        controller,
        (m) =>
            m.type === 'change' &&
            (m as { added?: unknown[] }).added?.length === 2
    )
    await send(source, {
        type: 'put',
        entities: [
            { id: 'p1', hp: 100, name: 'Alice' },
            { id: 'p2', hp: 80, name: 'Bob' },
        ],
    })
    const change = await changePromise
    expect(change.added?.length).toBe(2)

    const getResp = once<ServerMessage & { type: 'snapshot' }>(
        controller,
        (m) =>
            m.type === 'snapshot' &&
            (m as { entities: Array<{ id: string }> }).entities.length === 1
    )
    await send(controller, { type: 'get', ids: ['p1'] })
    const got = await getResp
    expect((got.entities[0] as { id: string }).id).toBe('p1')

    source.close()
    controller.close()
})

test('controller commands are delivered to the source', async () => {
    const harness = await startServer()
    harnessRef.current = harness

    const source = await openSocket(harness.url)
    const controller = await openSocket(harness.url)

    await register(source, 'cmd-test', 'source')
    await register(controller, 'cmd-test', 'controller')

    const oneShot = once<ServerMessage & { type: 'command'; cmd: { id: string; kind: string } }>(
        source,
        (m) => m.type === 'command' && (m as { cmd: { kind: string } }).cmd.kind === 'one-shot'
    )
    await send(controller, {
        type: 'command',
        kind: 'one-shot',
        payload: { key: 'space' },
    })
    const cmdOne = await oneShot
    expect(cmdOne.cmd.kind).toBe('one-shot')
    expect((cmdOne.cmd.payload as { key: string }).key).toBe('space')

    const activeCmd = once<ServerMessage & { type: 'command'; cmd: { id: string; kind: string } }>(
        source,
        (m) => m.type === 'command' && (m as { cmd: { kind: string } }).cmd.kind === 'active'
    )
    await send(controller, {
        type: 'command',
        kind: 'active',
        payload: { key: 'w' },
    })
    const cmdActive = await activeCmd
    expect(cmdActive.cmd.kind).toBe('active')

    const snapResp = once<ServerMessage & { type: 'snapshot'; activeCommands: Array<{ id: string }> }>(
        controller,
        (m) =>
            m.type === 'snapshot' &&
            (m as { activeCommands: Array<{ id: string }> }).activeCommands.length === 1
    )
    await send(controller, { type: 'snapshot' })
    const snap = await snapResp
    expect(snap.activeCommands[0].id).toBe(cmdActive.cmd.id)

    const cleared = once<ServerMessage & { type: 'commandCleared' }>(
        source,
        (m) => m.type === 'commandCleared'
    )
    await send(controller, { type: 'clearCommand', id: cmdActive.cmd.id })
    const clearedMsg = await cleared
    expect(clearedMsg.id).toBe(cmdActive.cmd.id)

    source.close()
    controller.close()
})

test('namespaces are isolated', async () => {
    const harness = await startServer()
    harnessRef.current = harness

    const a = await openSocket(harness.url)
    const b = await openSocket(harness.url)

    await register(a, 'namespace-a', 'source')
    await register(b, 'namespace-b', 'source')

    await send(a, { type: 'put', entities: [{ id: 'x', value: 1 }] })

    const bSnap = once<ServerMessage & { type: 'snapshot' }>(
        b,
        (m) => m.type === 'snapshot'
    )
    await send(b, { type: 'snapshot' })
    const snap = await bSnap
    expect(snap.entities.length).toBe(0)

    a.close()
    b.close()
})

test('patch + delete operations emit correct deltas', async () => {
    const harness = await startServer()
    harnessRef.current = harness

    const source = await openSocket(harness.url)
    const controller = await openSocket(harness.url)

    await register(source, 'patch-test', 'source')
    await register(controller, 'patch-test', 'controller')
    await send(controller, { type: 'subscribe', topics: ['entities'] })
    await once(controller, (m) => m.type === 'snapshot')

    const addPromise = once<ServerMessage & { type: 'change' }>(
        controller,
        (m) => m.type === 'change' && (m as { added?: unknown[] }).added?.length === 1
    )
    await send(source, { type: 'put', entities: [{ id: 'p1', hp: 100, name: 'X' }] })
    await addPromise

    const patchPromise = once<ServerMessage & { type: 'change' }>(
        controller,
        (m) => m.type === 'change' && (m as { updated?: unknown[] }).updated?.length === 1
    )
    await send(source, {
        type: 'patch',
        updates: [{ id: 'p1', set: { hp: 42 }, unset: ['name'] }],
    })
    const upd = await patchPromise
    const updated = upd.updated?.[0] as { id: string; hp: number; name?: string }
    expect(updated.hp).toBe(42)
    expect(updated.name).toBeUndefined()

    const delPromise = once<ServerMessage & { type: 'change' }>(
        controller,
        (m) => m.type === 'change' && (m as { removed?: string[] }).removed?.length === 1
    )
    await send(source, { type: 'delete', ids: ['p1'] })
    const del = await delPromise
    expect(del.removed).toEqual(['p1'])

    source.close()
    controller.close()
})

test('graceful source takeover closes the previous source', async () => {
    const harness = await startServer()
    harnessRef.current = harness

    const first = await openSocket(harness.url)
    const second = await openSocket(harness.url)

    await register(first, 'takeover', 'source')
    const firstClosed = new Promise<void>((resolve) => first.on('close', () => resolve()))
    await register(second, 'takeover', 'source')
    await firstClosed

    second.close()
})
