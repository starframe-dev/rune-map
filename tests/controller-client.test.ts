import { afterEach, expect, test } from 'vitest'
import WebSocket from 'ws'
import { ControllerClient } from '../src/client/controller-client.js'
import { StateServer } from '../src/server/index.js'
import type { ServerMessage } from '../src/core/types.js'

let server: StateServer | undefined

async function openSource(url: string): Promise<WebSocket> {
    const source = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
        source.once('open', resolve)
        source.once('error', reject)
    })
    source.send(JSON.stringify({ type: 'register', role: 'source', namespace: 'client-test' }))
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('source registration timeout')), 3000)
        source.on('message', (raw) => {
            const message = JSON.parse(raw.toString()) as ServerMessage
            if (message.type !== 'ready') return
            clearTimeout(timer)
            resolve()
        })
    })
    return source
}

afterEach(async () => {
    await server?.stop()
    server = undefined
})

test('controller client reads scene entities and sends commands without source takeover', async () => {
    server = await StateServer.create({ port: 0 })
    const source = await openSource(`ws://localhost:${server.port}`)
    source.send(JSON.stringify({
        type: 'put',
        entities: [{ id: 'scene', snapshot: { summary: 'Тестовая сцена', objects: [{ name: 'player-local', position: { x: 1, z: 2 } }] } }],
    }))

    const client = new ControllerClient({
        namespace: 'client-test',
        url: `ws://localhost:${server.port}`,
    })
    await client.connect()
    const initial = await client.snapshot()
    expect(initial.entities).toHaveLength(1)
    expect(initial.entities[0].id).toBe('scene')

    const change = client.waitFor((message): message is Extract<ServerMessage, { type: 'change' }> =>
        message.type === 'change' && message.updated?.some((entity) => entity.id === 'scene') === true
    )
    await client.subscribe(['entities'])
    const commandPromise = new Promise<ServerMessage & { type: 'command' }>((resolve) => {
        source.on('message', (raw) => {
            const message = JSON.parse(raw.toString()) as ServerMessage
            if (message.type === 'command') resolve(message as ServerMessage & { type: 'command' })
        })
    })
    const command = await client.command('one-shot', { action: 'move', x: 3, z: 4 })
    const received = await commandPromise
    expect(received.type).toBe('command')
    expect(received.cmd.id).toBe(command.id)

    source.send(JSON.stringify({
        type: 'put',
        entities: [{ id: 'scene', snapshot: { summary: 'Обновлённая сцена', objects: [{ name: 'player-local', position: { x: 3, z: 4 } }] } }],
    }))
    const updated = await change
    expect(updated.type).toBe('change')
    expect(client.namespace).toBe('client-test')

    client.close()
    source.close()
})
