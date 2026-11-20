import type { Incident } from './types'
import { fetchIncidents } from './api'
import { statusName } from './format'

/**
 * Разрешённые переходы статусов — зеркальная копия карты бэкенда
 * (app/incidents.py TRANSITIONS). Из «Закрыт» выходов нет: повторный
 * инцидент заводится как новая запись.
 */
export const ALLOWED_TRANSITIONS: Record<number, readonly number[]> = {
  0: [2, 7],
  2: [0, 7],
  7: [2, 20, 10],
  20: [2, 10],
  10: [],
}

export function isTransitionAllowed(from: number, to: number): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to)
}

export function invalidReason(from: number, to: number): string {
  if (from === 10) return 'Закрытый инцидент нельзя вернуть в работу — создаётся новый инцидент'
  return `Переход «${statusName(from)}» → «${statusName(to)}» не разрешён`
}

let wsSeq = 0
const wsSeen = new Map<string, number>()
const inFlight = new Set<string>()

/** Вызывается провайдером на каждое WS-сообщение типа update. */
export function noteWsUpdate(incidentIds: readonly string[]): void {
  wsSeq += 1
  for (const id of incidentIds) wsSeen.set(id, wsSeq)
}

export function isTransitionInFlight(id: string): boolean {
  return inFlight.has(id)
}

export interface TransitionHooks {
  onMoveStarted: (id: string) => void
  onMoveFinished: (id: string) => void
  onApplied: (text: string) => void
  onFailed: (text: string) => void
  onResync: (incidents: Incident[]) => void
}

const WS_CONFIRM_TIMEOUT_MS = 2000
const CONFIRM_POLL_MS = 150

/**
 * Смена статуса перетаскиванием. Без оптимистичного переноса: карточку
 * двигает только WS-обновление; если подтверждения нет 2 с — контрольный
 * запрос GET /api/incidents. Повторный дроп по тому же инциденту, пока
 * запрос в полёте, игнорируется.
 */
export async function transitionState(incidentId: string, targetStateId: number, hooks: TransitionHooks): Promise<void> {
  if (inFlight.has(incidentId)) return
  inFlight.add(incidentId)
  hooks.onMoveStarted(incidentId)
  const seqBefore = wsSeq
  try {
    const res = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stateId: targetStateId }),
    })
    if (!res.ok) {
      hooks.onFailed(`Не удалось изменить статус ${incidentId}: ${await errorReason(res)}`)
      return
    }
    hooks.onApplied(`${incidentId} → ${statusName(targetStateId)}`)
    const confirmed = await waitUntil(() => (wsSeen.get(incidentId) ?? 0) > seqBefore, WS_CONFIRM_TIMEOUT_MS)
    if (!confirmed) {
      try {
        const data = await fetchIncidents()
        hooks.onResync(data.incidents)
      } catch (err) {
        console.error('Не удалось обновить данные после смены статуса', err)
      }
    }
  } catch (err) {
    console.error('Ошибка запроса смены статуса инцидента', err)
    hooks.onFailed(`Не удалось изменить статус ${incidentId}: сервер недоступен`)
  } finally {
    inFlight.delete(incidentId)
    hooks.onMoveFinished(incidentId)
  }
}

/** Причина ошибки сервера: FastAPI отдаёт {"detail": "<причина>"}. */
async function errorReason(res: Response): Promise<string> {
  let parsed: unknown = null
  try {
    parsed = await res.json()
  } catch (err) {
    console.error('Не удалось разобрать тело ошибки сервера', err)
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const record = parsed as Record<string, unknown>
    const detail = record.detail
    if (typeof detail === 'string' && detail.trim() !== '') return detail
    if (typeof detail === 'object' && detail !== null) {
      const message = (detail as Record<string, unknown>).message
      if (typeof message === 'string' && message.trim() !== '') return message
    }
    if (typeof record.message === 'string' && record.message.trim() !== '') return record.message
  }
  return `HTTP ${res.status}`
}

function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const startedAt = Date.now()
    const poll = () => {
      if (check()) {
        resolve(true)
        return
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false)
        return
      }
      window.setTimeout(poll, CONFIRM_POLL_MS)
    }
    poll()
  })
}
