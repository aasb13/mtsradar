/**
 * Соединение с /api/ws?token=... События типизированы ключами маршрутов
 * (incident.updated, incident.removed, ...). Переподключение с задержкой
 * 1с → 2с → 4с → 8с → 15с. После (пере)подключения фронт обязан
 * перезапросить /dashboard — пропущенные события не повторяются.
 */

import { getAccessToken } from './api'
import type { WsEnvelope } from './types'

export interface SocketHandlers {
  onState: (state: 'connecting' | 'online' | 'reconnecting') => void
  onEvent: (event: WsEnvelope) => void
  onReconnected: () => void
}

export function connectSocket(handlers: SocketHandlers): () => void {
  let socket: WebSocket | null = null
  let attempt = 0
  let reconnectTimer: number | null = null
  let disposed = false
  let everConnected = false

  const scheduleReconnect = () => {
    const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 4), 15000)
    reconnectTimer = window.setTimeout(connect, delay)
  }

  const connect = () => {
    handlers.onState(everConnected ? 'reconnecting' : 'connecting')
    const token = getAccessToken()
    if (token === null) {
      scheduleReconnect()
      return
    }
    const scheme = window.location.protocol === 'https:' ? 'wss://' : 'ws://'
    try {
      socket = new WebSocket(`${scheme}${window.location.host}/api/ws?token=${encodeURIComponent(token)}`)
    } catch (err) {
      console.error('Не удалось открыть WebSocket-соединение', err)
      attempt += 1
      scheduleReconnect()
      return
    }
    socket.onopen = () => {
      const wasOffline = everConnected
      everConnected = true
      attempt = 0
      handlers.onState('online')
      if (wasOffline) handlers.onReconnected()
    }
    socket.onmessage = (event: MessageEvent) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(event.data))
      } catch {
        console.error('Некорректный JSON по WebSocket — пропущено', event.data)
        return
      }
      if (typeof parsed !== 'object' || parsed === null) return
      const envelope = parsed as Record<string, unknown>
      if (envelope.type === 'hello' || envelope.type === 'pong') return
      handlers.onEvent({
        eventId: typeof envelope.eventId === 'string' ? envelope.eventId : undefined,
        type: String(envelope.type),
        ts: String(envelope.ts ?? ''),
        payload: (envelope.payload ?? {}) as Record<string, unknown>,
      })
    }
    socket.onerror = () => {
      console.error('Ошибка WebSocket-соединения')
    }
    socket.onclose = () => {
      socket = null
      if (disposed) return
      attempt += 1
      handlers.onState('reconnecting')
      scheduleReconnect()
    }
  }

  connect()

  return () => {
    disposed = true
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    socket?.close()
  }
}
