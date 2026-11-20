import type { WsChange, WsMessage } from './types'

const CHANGE_KINDS = new Set<string>([
  'created',
  'updated',
  'resolved',
  'reopened',
  'research_new',
  'critical_new',
  'coordinator_assigned',
  'priority_changed',
  'deadline_changed',
])

export interface SocketHandlers {
  onState: (state: 'connecting' | 'online' | 'reconnecting') => void
  onMessage: (message: WsMessage) => void
}

function isChange(value: unknown): value is WsChange {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.kind === 'string' && CHANGE_KINDS.has(o.kind)
}

function parsePayload(payload: unknown, type: 'snapshot' | 'update'): WsMessage | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>
  if (!Array.isArray(p.incidents)) return null
  const summary = p.summary
  if (typeof summary !== 'object' || summary === null) return null
  const s = summary as Record<string, unknown>
  if (typeof s.kpi !== 'object' || s.kpi === null) return null
  const incidents = p.incidents as WsMessage['payload']['incidents']
  const parsedSummary = summary as WsMessage['payload']['summary']
  const ts = typeof p.ts === 'string' ? p.ts : ''
  if (type === 'snapshot') {
    return { type: 'snapshot', payload: { incidents, summary: parsedSummary, ts } }
  }
  if (!Array.isArray(p.changes)) return null
  const changes: WsChange[] = []
  for (const raw of p.changes as unknown[]) {
    if (isChange(raw)) {
      changes.push(raw)
    } else {
      console.warn('Изменение с неизвестным форматом или типом пропущено', raw)
    }
  }
  return { type: 'update', payload: { incidents, summary: parsedSummary, changes, ts } }
}

export function parseWsMessage(raw: unknown): WsMessage | null {
  if (typeof raw !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  if (obj.type !== 'snapshot' && obj.type !== 'update') return null
  return parsePayload(obj.payload, obj.type)
}

/**
 * Соединение с /api/ws через vite-прокси. Автопереподключение
 * с экспоненциальной задержкой 1с → 2с → 4с → 8с → 15с (потолок).
 * Возвращает функцию освобождения ресурсов.
 */
export function connectDashboardSocket(handlers: SocketHandlers): () => void {
  let socket: WebSocket | null = null
  let attempt = 0
  let reconnectTimer: number | null = null
  let disposed = false

  const scheduleReconnect = () => {
    const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 4), 15000)
    reconnectTimer = window.setTimeout(connect, delay)
  }

  const connect = () => {
    handlers.onState(attempt === 0 ? 'connecting' : 'reconnecting')
    const scheme = window.location.protocol === 'https:' ? 'wss://' : 'ws://'
    try {
      socket = new WebSocket(`${scheme}${window.location.host}/api/ws`)
    } catch (err) {
      console.error('Не удалось открыть WebSocket-соединение', err)
      attempt += 1
      scheduleReconnect()
      return
    }
    socket.onopen = () => {
      attempt = 0
      handlers.onState('online')
    }
    socket.onmessage = (event: MessageEvent) => {
      const message = parseWsMessage(event.data)
      if (message === null) {
        console.error('Получено некорректное сообщение по WebSocket — пропущено', event.data)
        return
      }
      handlers.onMessage(message)
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
