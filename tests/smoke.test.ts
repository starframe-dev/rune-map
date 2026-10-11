import { test, expect } from 'vitest'
import WebSocket from 'ws'
import { WebSocketServer } from 'ws'

test('ws server round-trip works', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const port = await new Promise<number>((resolve) => {
        wss.once('listening', () => {
            const addr = wss.address()
            resolve(typeof addr === 'object' && addr ? addr.port : 0)
        })
    })

    wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
            ws.send(`echo:${raw.toString()}`)
        })
    })

    const ws = new WebSocket(`ws://localhost:${port}`)
    await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', reject)
    })

    const echo = new Promise<string>((resolve) => {
        ws.once('message', (raw) => resolve(raw.toString()))
    })

    ws.send('hello')
    const result = await echo
    expect(result).toBe('echo:hello')

    ws.close()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
})
