import type { Card, Sla } from './types'

const shortDateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

const dayMonthFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' })

const weekdayDateFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })

function safeParse(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined || iso === '') return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

export function formatShort(iso: string | null | undefined): string {
  const t = safeParse(iso)
  return t === null ? '—' : shortDateFmt.format(t)
}

export function formatDayMonth(iso: string | null | undefined): string {
  const t = safeParse(iso)
  return t === null ? '—' : dayMonthFmt.format(t)
}

export function todayWeekday(now: number): string {
  const s = weekdayDateFmt.format(now)
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** «2д 04:11:33» — дни показываются только когда есть. */
export function formatTimeLeft(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const days = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (days > 0) return `${days}д ${pad2(h)}:${pad2(m)}:${pad2(sec)}`
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`
}

/** Просрочка: «2д 04:11» при сутках, «04:11» под сутками. */
export function formatOverdue(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const days = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (days > 0) return `${days}д ${pad2(h)}:${pad2(m)}`
  return `${pad2(h)}:${pad2(m)}`
}

/** Слова: «1д 3ч», «1ч 19м», «45м», «менее минуты». */
export function formatDurationWords(totalSeconds: number | null): string {
  if (totalSeconds === null) return '—'
  const s = Math.max(0, Math.floor(totalSeconds))
  if (s < 60) return 'менее минуты'
  const days = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (days > 0) return h > 0 ? `${days}д ${h}ч` : `${days}д`
  if (h > 0) return h > 0 && m > 0 ? `${h} ч ${m} мин` : `${h} ч`
  return `${m} мин`
}

export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return '—'
  if (minutes < 1) return `${Math.round(minutes * 60)} с`
  return formatDurationWords(Math.round(minutes * 60))
}

/** «только что» / «5 мин назад» / «2 ч назад» / дата. */
export function relativeTime(iso: string | null | undefined, now: number): string {
  const t = safeParse(iso)
  if (t === null) return '—'
  const diff = Math.max(0, Math.floor((now - t) / 1000))
  if (diff < 60) return 'только что'
  if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`
  return shortDateFmt.format(t)
}

/**
 * Живой SLA: значения от бэкенда фиксируются в updatedAt карточки
 * (каждое WS-обновление приносит свежую карточку), дальше секунды
 * тикают локально между обновлениями. Замороженные инциденты
 * показывают время, зафиксированное на момент заморозки.
 */
export interface LiveSla {
  state: 'ok' | 'warning' | 'danger' | 'breach' | 'none' | 'resolved'
  label: string
  breached: boolean
}

export function liveSla(card: Card, now: number): LiveSla {
  const sla = card.sla
  const frozen = card.freeze != null
  const anchor = safeParse(card.updatedAt)
  // у замороженного sla зафиксирован сервером на момент начала паузы — секунды не тикают
  const elapsed = frozen || anchor === null ? 0 : Math.max(0, (now - anchor) / 1000)
  switch (sla.state) {
    case 'resolved': {
      const from = safeParse(card.submitDate)
      const to = safeParse(card.completionDate)
      if (from === null || to === null) return { state: 'resolved', label: 'Решено', breached: false }
      return { state: 'resolved', label: `Решён за ${formatDurationWords((to - from) / 1000)}`, breached: false }
    }
    case 'none':
      return { state: 'none', label: 'Срок не задан', breached: false }
    case 'breached': {
      const overdue = frozen ? Math.max(0, -(sla.timeLeftSeconds ?? 0)) : (sla.overdueSeconds ?? 0) + elapsed
      return { state: 'breach', label: `Просрочен на ${formatOverdue(overdue)}`, breached: true }
    }
    case 'ok':
    case 'warning':
    case 'danger': {
      if (sla.timeLeftSeconds === null) return { state: 'none', label: 'Срок не задан', breached: false }
      const left = sla.timeLeftSeconds - elapsed
      if (left < 0) return { state: 'breach', label: `Просрочен на ${formatOverdue(-left)}`, breached: true }
      return { state: sla.state, label: `${formatTimeLeft(left)} осталось`, breached: false }
    }
  }
}

/** Крупное значение для SLA-блока панели: остаток, просрочка или факт решения. */
export function slaBigValue(card: Card, now: number): string {
  const sla = liveSla(card, now)
  const frozen = card.freeze != null
  const anchor = safeParse(card.updatedAt)
  const elapsed = frozen || anchor === null ? 0 : Math.max(0, (now - anchor) / 1000)
  switch (sla.state) {
    case 'breach':
      return formatOverdue(frozen ? Math.max(0, -(card.sla.timeLeftSeconds ?? 0)) : (card.sla.overdueSeconds ?? 0) + elapsed)
    case 'ok':
    case 'warning':
    case 'danger':
      return formatTimeLeft(Math.max(0, (card.sla.timeLeftSeconds ?? 0) - elapsed))
    case 'resolved': {
      const from = safeParse(card.submitDate)
      const to = safeParse(card.completionDate)
      if (from === null || to === null) return '—'
      return formatDurationWords((to - from) / 1000)
    }
    default:
      return '—'
  }
}

/** «1 координатор, 2 координатора, 5 координаторов». */
export function pluralize(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

const SLA_RANK: Record<Sla['state'], number> = {
  breached: 0,
  danger: 1,
  warning: 2,
  ok: 3,
  none: 4,
  resolved: 5,
}

/** Сначала просроченные и горящие, решённые — в конец. */
export function compareCards(a: Card, b: Card): number {
  const ra = SLA_RANK[a.sla.state]
  const rb = SLA_RANK[b.sla.state]
  if (ra !== rb) return ra - rb
  if (a.isCritical !== b.isCritical) return a.isCritical ? -1 : 1
  const da = safeParse(a.deadline) ?? Number.POSITIVE_INFINITY
  const db = safeParse(b.deadline) ?? Number.POSITIVE_INFINITY
  if (da !== db) return da - db
  return (safeParse(b.submitDate) ?? 0) - (safeParse(a.submitDate) ?? 0)
}

export function priorityMeta(priorityId: number): { label: string; tone: 'critical' | 'high' | 'medium' | 'low' } {
  switch (priorityId) {
    case 4:
      return { label: 'Критический', tone: 'critical' }
    case 3:
      return { label: 'Высокий', tone: 'high' }
    case 2:
      return { label: 'Средний', tone: 'medium' }
    default:
      return { label: 'Низкий', tone: 'low' }
  }
}

/** Колонки «Групп внимания» = уровни приоритета (кейс: группы 4→1). */
export function levelTitle(priorityId: number): string {
  return `${priorityId} уровень`
}

export function statusPillTone(stateId: number): 'todo' | 'work' | 'review' | 'done' | 'frozen' | 'breach' {
  switch (stateId) {
    case 0:
    case 20:
      return 'todo'
    case 2:
      return 'work'
    case 7:
      return 'review'
    case 10:
      return 'done'
    default:
      return 'todo'
  }
}

export const STATE_PILL_TEXT: Record<number, string> = {
  0: 'К выполнению',
  2: 'В работе',
  7: 'На проверке',
  10: 'Закрыт',
  20: 'Исследование',
}

export function initials(fullName: string | null | undefined): string {
  if (fullName === null || fullName === undefined || fullName.trim() === '') return '?'
  const parts = fullName.trim().split(/\s+/)
  const a = parts[0]?.charAt(0) ?? ''
  const b = parts[1]?.charAt(0) ?? ''
  return (a + b).toUpperCase() || '?'
}

/** «Сидорова М.» из «Сидорова Мария» и т.п. — фамилия + инициал. */
export function shortName(fullName: string | null | undefined): string {
  if (fullName === null || fullName === undefined || fullName.trim() === '') return '—'
  const parts = fullName.trim().split(/\s+/)
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[1]?.charAt(0) ?? ''}.`
}

export const FEED_TEXT: Record<string, string> = {
  'incident.created': 'зарегистрирован',
  'incident.updated': 'обновлён',
  'incident.removed': 'удалён',
  'incident.acknowledged': 'принят в работу',
  'incident.comment_added': 'новый комментарий',
  'incident.ai_updated': 'обновлён анализ BigDad',
  'incident.sla': 'изменён SLA-статус',
  'import.completed': 'импорт данных завершён',
  'import.failed': 'ошибка импорта данных',
  'notification.created': 'уведомление',
}
