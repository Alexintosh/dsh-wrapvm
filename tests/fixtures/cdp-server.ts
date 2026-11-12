/** Minimal external CDP peer; exercises the host's native WebSocket without an added dependency. */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'

interface Command {
  id: number
  method: string
  params: Record<string, unknown>
}

interface Peer {
  send(value: object, fragmented?: boolean): void
  text(value: string): void
  disconnect(): void
}

function frame(text: string, opcode: number, final: boolean): Buffer {
  const data = Buffer.from(text)
  const header = Buffer.alloc(data.length < 126 ? 2 : data.length <= 65535 ? 4 : 10)
  header[0] = (final ? 0x80 : 0) | opcode
  header[1] = data.length < 126 ? data.length : data.length <= 65535 ? 126 : 127
  if (header.length === 4) header.writeUInt16BE(data.length, 2)
  if (header.length === 10) header.writeBigUInt64BE(BigInt(data.length), 2)
  return Buffer.concat([header, data])
}

/** Start a separately owned TCP CDP peer and return its port and awaited cleanup. */
export async function cdpServer(handle: (command: Command, peer: Peer) => void, rejectUpgrade: boolean = false, onUpgrade?: () => void): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Duplex>()
  const server = createServer((_request, response) => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing CDP fixture port')
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/fixture` }))
  })
  server.on('upgrade', (request, socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', (error: NodeJS.ErrnoException) => {
      // Client cancellation may reset an upgraded socket before its handshake is read.
      if (error.code !== 'ECONNRESET') throw error
    })
    onUpgrade?.()
    if (rejectUpgrade) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      return
    }
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') throw new Error('missing WebSocket key')
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const peer: Peer = {
      send(value, fragmented = false) {
        const text = JSON.stringify(value)
        if (!fragmented) socket.write(frame(text, 1, true))
        else {
          const middle = Math.floor(text.length / 2)
          socket.write(frame(text.slice(0, middle), 1, false))
          socket.write(frame(text.slice(middle), 0, true))
        }
      },
      text(value) { socket.write(frame(value, 1, true)) },
      disconnect() { socket.end(frame('', 8, true)) },
    }
    let buffered = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      while (buffered.length >= 2) {
        const opcode = buffered[0]! & 15
        const marker = buffered[1]! & 127
        let offset = marker === 126 ? 4 : marker === 127 ? 10 : 2
        if (buffered.length < offset) return
        const length = marker === 126 ? buffered.readUInt16BE(2) : marker === 127 ? Number(buffered.readBigUInt64BE(2)) : marker
        const masked = (buffered[1]! & 128) !== 0
        const mask = buffered.subarray(offset, offset + 4)
        if (masked) offset += 4
        if (buffered.length < offset + length) return
        const data = Buffer.from(buffered.subarray(offset, offset + length))
        buffered = buffered.subarray(offset + length)
        if (masked) for (let index = 0; index < data.length; index++) data[index] = data[index]! ^ mask[index % 4]!
        if (opcode === 8) {
          if (!socket.writableEnded) socket.end(frame('', 8, true))
          return
        }
        if (opcode === 1) handle(JSON.parse(data.toString()) as Command, peer)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing CDP fixture port')
  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
