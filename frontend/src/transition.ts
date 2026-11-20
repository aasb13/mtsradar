import type { Incident } from './types'
import { fetchIncidents } from './api'
import { FINAL_STAGE, stageName } from './format'

/**
 * Колонка «Инцидент полностью завершен» — финальная: карточки можно
 * перетаскивать в любую другую колонку, но не из неё. Повторный
 * инцидент заводится как новая запись.
 */
export function isTransitionAllowed(from: number, to: number): boolean {
  return from !== FINAL_STAGE && from !== to
}

export function invalidReason(from: number, to: number): string {
  if (from === FINAL_STAGE) return 'Полностью завершенный инцидент нельзя вернуть в работу — создаётся новый инцидент'
  return `Переход «${stageName(from)}» → «${stageName(to)}» не разрешён`
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
 * Перенос карточки в другую колонку. Без оптимистичного переноса: карточку
 * двигает только WS-обновление, которое сервер рассылает сразу после записи
 * файла; если подтверждения нет 2 с — контрольный запрос GET /api/incidents.
 * Повторный дроп по тому же инциденту, пока запрос в полёте, игнорируется.
 */
export async function transitionStage(incidentId: string, targetStageId: number, hooks: TransitionHooks): Promise<void> {
  if (inFlight.has(incidentId)) return
  inFlight.add(incidentId)
  hooks.onMoveStarted(incidentId)
  const seqBefore = wsSeq
  try {
    const res = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stageId: targetStageId }),
    })
    if (!res.ok) {
      hooks.onFailed(`Не удалось перенести карточку ${incidentId}: ${await errorReason(res)}`)
      return
    }
    hooks.onApplied(`${incidentId} → ${stageName(targetStageId)}`)
    const confirmed = await waitUntil(() => (wsSeen.get(incidentId) ?? 0) > seqBefore, WS_CONFIRM_TIMEOUT_MS)
    if (!confirmed) {
      try {
        const data = await fetchIncidents()
        hooks.onResync(data.incidents)
      } catch (err) {
        console.error('Не удалось обновить данные после переноса карточки', err)
      }
    }
  } catch (err) {
    console.error('Ошибка запроса переноса карточки', err)
    hooks.onFailed(`Не удалось перенести карточку ${incidentId}: сервер недоступен`)
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
