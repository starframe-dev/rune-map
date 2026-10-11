import WebSocket, { type RawData } from 'ws'
import type {
    ClientMessage,
    Command,
    CommandKind,
    ServerMessage,
    Topic,
} from '../core/types.js'

export interface ControllerClientOptions {
    namespace: string
    url: string
}

export type ServerMessageHandler = (message: ServerMessage) => void

type MessagePredicate<T extends ServerMessage> = (message: ServerMessage) => message is T

/** Controller-only WebSocket client. It never starts or replaces a source. */
export class ControllerClient {
    readonly namespace: string
    private readonly url: string
    private socket: WebSocket | null = null
    private readonly handlers = new Set<ServerMessageHandler>()
    private readonly waiters = new Set<PendingMessage>()

    constructor(options: ControllerClientOptions) {
        this.namespace = options.namespace
        this.url = options.url
    }

    async connect(): Promise<void> {
        const socket = new WebSocket(this.url)
        this.socket = socket
        await new Promise<void>((resolve, reject) => {
            const onOpen = (): void => {
                socket.off('error', onError)
                resolve()
            }
            const onError = (error: Error): void => {
                socket.off('open', onOpen)
                reject(error)
            }
            socket.once('open', onOpen)
            socket.once('error', onError)
        })

        socket.on('message', (raw: RawData) => {
            const message = parseServerMessage(raw)
            if (!message) return
            for (const handler of this.handlers) {
                handler(message)
            }
            for (const waiter of this.waiters) {
                if (!waiter.matches(message)) continue
                this.waiters.delete(waiter)
                waiter.resolve(message)
            }
        })
        socket.once('close', () => {
            for (const waiter of this.waiters) {
                waiter.reject(new Error('RuneMap controller connection closed'))
            }
            this.waiters.clear()
        })

        const ready = this.waitFor((message): message is Extract<ServerMessage, { type: 'ready' }> =>
            message.type === 'ready' && message.role === 'controller'
        )
        await this.send({
            type: 'register',
            role: 'controller',
            namespace: this.namespace,
        })
        await ready
    }

    async snapshot(): Promise<Extract<ServerMessage, { type: 'snapshot' }>> {
        const response = this.waitFor((message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
            message.type === 'snapshot'
        )
        await this.send({ type: 'snapshot' })
        return response
    }

    async subscribe(topics: Topic[]): Promise<Extract<ServerMessage, { type: 'snapshot' }>> {
        const response = this.waitFor((message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
            message.type === 'snapshot'
        )
        await this.send({ type: 'subscribe', topics })
        return response
    }

    async namespaces(): Promise<string[]> {
        const response = this.waitFor((message): message is Extract<ServerMessage, { type: 'namespaces' }> =>
            message.type === 'namespaces'
        )
        await this.send({ type: 'namespaces' })
        return (await response).namespaces
    }

    async command(
        kind: CommandKind,
        payload: Record<string, unknown>,
        target?: string,
    ): Promise<Command> {
        const response = this.waitFor((message): message is Extract<ServerMessage, { type: 'command' }> =>
            message.type === 'command'
        )
        await this.send({ type: 'command', kind, payload, target })
        return (await response).cmd
    }

    waitFor<T extends ServerMessage>(
        predicate: MessagePredicate<T>,
        timeout = 10000,
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const pending = new PendingMessage(predicate, (message) => resolve(message as T), reject, timeout)
            this.waiters.add(pending)
        })
    }

    onMessage(handler: ServerMessageHandler): () => void {
        this.handlers.add(handler)
        return () => this.handlers.delete(handler)
    }

    close(): void {
        this.socket?.close()
        this.socket = null
    }

    private send(message: ClientMessage): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = this.socket
            if (!socket || socket.readyState !== WebSocket.OPEN) {
                reject(new Error('RuneMap controller socket is not open'))
                return
            }
            socket.send(JSON.stringify(message), (error) => {
                if (error) reject(error)
                else resolve()
            })
        })
    }
}

class PendingMessage {
    private readonly timer: NodeJS.Timeout

    constructor(
        private readonly predicate: MessagePredicate<ServerMessage>,
        readonly resolve: (message: ServerMessage) => void,
        readonly reject: (error: Error) => void,
        timeout: number,
    ) {
        this.timer = setTimeout(() => {
            this.reject(new Error('Timed out waiting for RuneMap server message'))
        }, timeout)
    }

    matches(message: ServerMessage): boolean {
        if (!this.predicate(message)) return false
        clearTimeout(this.timer)
        return true
    }
}

function parseServerMessage(raw: RawData): ServerMessage | null {
    try {
        const parsed: unknown = JSON.parse(raw.toString())
        if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
            return null
        }
        return parsed as ServerMessage
    } catch {
        return null
    }
}
