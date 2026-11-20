import type { ChangeKind, Incident, IncidentGroup, SlaState, ToastType } from './types'

const shortDateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

const fullDateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

function safeParse(iso: string | null): number | null {
  if (iso === null || iso === '') return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

export function formatShort(iso: string | null): string {
  const t = safeParse(iso)
  return t === null ? '—' : shortDateFmt.format(t)
}

export function formatFull(iso: string | null): string {
  const t = safeParse(iso)
  return t === null ? '—' : fullDateFmt.format(t)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** «2д 04:11:33» — дни показываются только когда есть; под сутками h:mm:ss. */
export function formatTimeLeft(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const days = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (days > 0) return `${days}д ${pad2(h)}:${pad2(m)}:${pad2(sec)}`
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`
}

/** Просрочка: «2д 04:11» при сутках, «04:11:33» под сутками. */
export function formatOverdue(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const days = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (days > 0) return `${days}д ${pad2(h)}:${pad2(m)}`
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`
}

/** Слова: «1д 3ч», «1ч 19м», «45м», «менее минуты». */
export function formatDurationWords(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  if (s < 60) return 'менее минуты'
  const days = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (days > 0) return h > 0 ? `${days}д ${h}ч` : `${days}д`
  if (h > 0) return `${h}ч ${m}м`
  return `${m}м`
}

export function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, Math.floor((now - ts) / 1000))
  if (diff < 60) return 'только что'
  if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`
  return shortDateFmt.format(ts)
}

export function durationBetween(fromIso: string | null, toIso: string | null): number | null {
  const from = safeParse(fromIso)
  const to = safeParse(toIso)
  if (from === null || to === null) return null
  return Math.max(0, (to - from) / 1000)
}

export interface LiveSla {
  state: SlaState
  label: string
  breached: boolean
}

/**
 * Пересчитывает SLA на «живых» часах: значения от бэкенда фиксируются
 * в момент snapshot/update (syncedAt), дальше таймстамп идёт локально.
 */
export function liveSla(incident: Incident, syncedAt: number | null, now: number): LiveSla {
  const sla = incident.sla
  const elapsed = syncedAt === null ? 0 : Math.max(0, (now - syncedAt) / 1000)
  switch (sla.state) {
    case 'done': {
      const secs = durationBetween(incident.submitDate, incident.completionDate)
      return { state: 'done', label: secs === null ? 'Решено' : `Решено за ${formatDurationWords(secs)}`, breached: false }
    }
    case 'none':
      return { state: 'none', label: 'Срок не задан', breached: false }
    case 'breach': {
      const overdue = (sla.overdueSeconds ?? 0) + elapsed
      return { state: 'breach', label: `Просрочен на ${formatOverdue(overdue)}`, breached: true }
    }
    case 'ok':
    case 'warning':
    case 'danger': {
      if (sla.timeLeftSeconds === null) return { state: 'none', label: 'Срок не задан', breached: false }
      const left = sla.timeLeftSeconds - elapsed
      if (left < 0) return { state: 'breach', label: `Просрочен на ${formatOverdue(-left)}`, breached: true }
      return { state: sla.state, label: `Осталось ${formatTimeLeft(left)}`, breached: false }
    }
  }
}

export const SLA_RANK: Record<SlaState, number> = {
  breach: 0,
  danger: 1,
  warning: 2,
  ok: 3,
  none: 4,
  done: 5,
}

function deadlineValue(incident: Incident): number {
  const t = safeParse(incident.deadline)
  return t === null ? Number.POSITIVE_INFINITY : t
}

function submitValue(incident: Incident): number {
  const t = safeParse(incident.submitDate)
  return t === null ? 0 : t
}

/** Сначала просроченные и горящие, решённые — в конец. */
export function compareIncidents(a: Incident, b: Incident, syncedAt: number | null, now: number): number {
  const ra = SLA_RANK[liveSla(a, syncedAt, now).state]
  const rb = SLA_RANK[liveSla(b, syncedAt, now).state]
  if (ra !== rb) return ra - rb
  if (ra <= SLA_RANK.ok) {
    const da = deadlineValue(a)
    const db = deadlineValue(b)
    if (da !== db) return da - db
  }
  return submitValue(b) - submitValue(a)
}

const STATUS_FALLBACK: Record<number, string> = {
  0: 'Назначен',
  2: 'Выполняется',
  7: 'Завершён',
  10: 'Закрыт',
  20: 'Исследование ситуации',
}

export function statusLabel(incident: Incident): string {
  if (typeof incident.state === 'string' && incident.state.trim() !== '') return incident.state
  return STATUS_FALLBACK[incident.stateId] ?? `Статус ${incident.stateId}`
}

export function statusClass(stateId: number): string {
  switch (stateId) {
    case 0:
      return 'st-assigned'
    case 2:
      return 'st-wip'
    case 7:
      return 'st-resolved'
    case 10:
      return 'st-closed'
    case 20:
      return 'st-research'
    default:
      return 'st-unknown'
  }
}

export interface StageMeta {
  id: number
  label: string
  cls: string
}

/** Колонки канбан-доски; зеркало карты бэкенда (app/incidents.py STAGE_STATE_IDS). */
export const STAGES: readonly StageMeta[] = [
  { id: 1, label: 'Ожидает координатора', cls: 'st-assigned' },
  { id: 2, label: 'Ожидает прикрепления команды', cls: 'st-assigned' },
  { id: 3, label: 'Ожидает решения инцидента', cls: 'st-assigned' },
  { id: 4, label: 'В процессе решения', cls: 'st-wip' },
  { id: 5, label: 'QA', cls: 'st-resolved' },
  { id: 6, label: 'Ожидает разбора (причины)', cls: 'st-research' },
  { id: 7, label: 'Инцидент полностью завершен', cls: 'st-closed' },
]

export const FINAL_STAGE = 7

export function stageName(stageId: number): string {
  return STAGES.find(stage => stage.id === stageId)?.label ?? `Колонка ${stageId}`
}

export function priorityMeta(priorityId: number): { label: string; cls: string } {
  switch (priorityId) {
    case 3:
      return { label: 'Высокий', cls: 'prio-high' }
    case 2:
      return { label: 'Средний', cls: 'prio-medium' }
    case 1:
      return { label: 'Низкий', cls: 'prio-low' }
    default:
      return { label: `Приоритет ${priorityId}`, cls: 'prio-low' }
  }
}

export const GROUP_META: Record<IncidentGroup, { label: string; cls: string }> = {
  critical: { label: 'Критический', cls: 'tag-critical' },
  coordinators: { label: 'У координаторов', cls: 'tag-coordinators' },
  high_priority: { label: 'Высокий приоритет', cls: 'tag-high' },
  research: { label: 'Исследование', cls: 'tag-research' },
}

export const FEED_TEXT: Record<ChangeKind, string> = {
  critical_new: 'стал критическим',
  deadline_changed: 'изменён срок',
  priority_changed: 'изменён приоритет',
  resolved: 'решён',
  reopened: 'возвращён в работу',
  research_new: 'передан на исследование ситуации',
  coordinator_assigned: 'назначен на координаторов',
  created: 'зарегистрирован',
  updated: 'обновлён',
}

export const TOAST_META: Record<ChangeKind, { type: ToastType; text: (id: string) => string }> = {
  critical_new: { type: 'critical', text: id => `Новый критический инцидент: ${id}` },
  deadline_changed: { type: 'warning', text: id => `${id} — изменён срок` },
  priority_changed: { type: 'info', text: id => `${id} — изменён приоритет` },
  resolved: { type: 'success', text: id => `${id} решён` },
  reopened: { type: 'info', text: id => `${id} возвращён в работу` },
  research_new: { type: 'info', text: id => `${id} передан на исследование ситуации` },
  coordinator_assigned: { type: 'info', text: id => `${id} назначен на координаторов` },
  created: { type: 'info', text: id => `${id} зарегистрирован` },
  updated: { type: 'info', text: id => `${id} обновлён` },
}

/** Из пачки изменений по инциденту в тост выходит самый значимый kind. */
export const KIND_PRIORITY: ChangeKind[] = [
  'critical_new',
  'deadline_changed',
  'priority_changed',
  'resolved',
  'reopened',
  'research_new',
  'coordinator_assigned',
  'created',
  'updated',
]

export function riskClass(score: number): 'critical' | 'high' | 'ok' {
  if (score >= 70) return 'critical'
  if (score >= 40) return 'high'
  return 'ok'
}
