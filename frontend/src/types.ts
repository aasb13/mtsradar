/**
 * Типы контракта с бэкендом ( FastAPI, /api/* ). Зеркало ответов сервера:
 * presenter.card / presenter.detail, /auth, /users, /notifications,
 * /dictionaries, /stats, /my/incidents, события WebSocket.
 */

export type Role = 'admin' | 'coordinator' | 'viewer' | 'developer'

export interface Sla {
  state: 'ok' | 'warning' | 'danger' | 'breached' | 'none' | 'resolved'
  timeLeftSeconds: number | null
  totalSeconds: number | null
  overdueSeconds: number | null
}

export type IncidentGroup = 'critical' | 'coordinators' | 'high' | 'research'

export interface AiCardInfo {
  summary: string | null
  riskScore: number | null
  stale?: boolean
}

export interface Card {
  id: string
  header: string | null
  shortDescription: string | null
  productName: string | null
  service: string | null
  scenarioName: string | null
  submitDate: string | null
  deadline: string | null
  completionDate: string | null
  stateId: number
  state: string | null
  priorityId: number
  priority: string | null
  assignedGroupName: string | null
  assignedEmployee: string | null
  assignedEmployeeLogin: string | null
  members: string[]
  serviceType: string | null
  groups: IncidentGroup[]
  isCritical: boolean
  isActive: boolean
  isResolved: boolean
  isNewCritical: boolean
  sla: Sla
  acknowledged: { userId: string; name?: string | null; at: string } | null
  ai: AiCardInfo | null
  itsmUrl: string
  updatedAt: string | null
  version: number
  deleted: boolean
}

export interface AiAlternative {
  group: string
  reason: string
}

export interface TeamRecommendation {
  recommendedGroup: string
  reason: string
  confidence: number
  alternatives: AiAlternative[]
  model: string | null
}

export interface AiDetail {
  summary: string | null
  riskScore: number | null
  riskReason: string | null
  recommendedGroup: string | null
  recommendedReason: string | null
  recommendedConfidence?: number | null
  recommendedAlternatives?: AiAlternative[] | null
  recommendedAt?: string | null
  recommendedModel?: string | null
  breachForecast: Record<string, unknown> | null
  model: string | null
  stale?: boolean
}

export interface TeamAiDescription {
  group: string
  text: string
  model: string | null
  updatedAt: string
}

export interface TeamDescriptionsResponse {
  descriptions: TeamAiDescription[]
}

export interface HistoryEvent {
  id: string
  incidentId: string
  at: string
  type: string
  source: string
  actor: { id?: string; name?: string | null } | null
  kinds: string[]
  changes: Record<string, unknown>[]
  [key: string]: unknown
}

export interface Comment {
  id: string
  incidentId: string
  author: { id?: string; name?: string | null } | null
  text: string
  createdAt: string
}

export interface IncidentDetail extends Card {
  data: Record<string, unknown>
  meta: Record<string, unknown>
  ai: AiDetail | null
  allowedTransitions: number[]
}

// состояния из домена бэкенда (app/domain/enums.py)
export const ASSIGNED = 0
export const IN_PROGRESS = 2
export const RESOLVED = 7
export const CLOSED = 10
export const RESEARCH = 20

export const STATE_NAMES: Record<number, string> = {
  0: 'Назначен',
  2: 'Выполняется',
  7: 'Завершён',
  10: 'Закрыт',
  20: 'Исследование ситуации',
}

export const PRIORITIES: Record<number, string> = {
  1: 'Низкий',
  2: 'Средний',
  3: 'Высокий',
  4: 'Наивысший',
}

/** Четыре колонки канбана из макета. 20 «Исследование» живёт в «К выполнению». */
export const BOARD_COLUMNS: { key: string; title: string; stateIds: number[] }[] = [
  { key: 'todo', title: 'К выполнению', stateIds: [ASSIGNED, RESEARCH] },
  { key: 'work', title: 'В работе', stateIds: [IN_PROGRESS] },
  { key: 'review', title: 'На проверке', stateIds: [RESOLVED] },
  { key: 'done', title: 'Решено', stateIds: [CLOSED] },
]

export const TRANSITIONS: Record<number, number[]> = {
  [ASSIGNED]: [IN_PROGRESS, RESOLVED],
  [IN_PROGRESS]: [ASSIGNED, RESOLVED, RESEARCH],
  [RESEARCH]: [RESOLVED, IN_PROGRESS],
  [RESOLVED]: [CLOSED, IN_PROGRESS],
  [CLOSED]: [],
}

/** SLA-бюджеты приоритетов для экрана статистики (из макета: «из 2ч/6ч/24ч/72ч»). */
export const PRIORITY_SLA_HOURS: Record<number, number> = { 1: 72, 2: 24, 3: 6, 4: 2 }

export interface Kpi {
  active: number
  critical: number
  coordinators: number
  high: number
  research: number
  breached: number
  resolvedToday: number
}

export interface DashboardResponse {
  serverTime: string
  groupTitles: Record<string, string>
  kpi: Kpi
  unacknowledgedCritical: string[]
  groups: Record<IncidentGroup, Card[]>
}

export interface BoardColumn {
  stateId: number
  title: string
  count: number
  cards: Card[]
}

export interface BoardResponse {
  serverTime: string
  columns: BoardColumn[]
  transitions: Record<string, number[]>
}

export interface IncidentsResponse {
  serverTime: string
  items: Card[]
  total: number
  page: number
  perPage: number
}

export interface User {
  id: string
  email: string
  fullName: string | null
  role: Role
  itsmLogin: string | null
  telegramChatId: string | null
  notificationSettings: Record<string, unknown>
  createdAt: string | null
  deletedAt: string | null
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  tokenType: string
  expiresIn: number
  user: User
}

export interface Notification {
  id: string
  userId: string
  kind: string
  title: string | null
  body: string | null
  incidentId: string | null
  createdAt: string
  readAt: string | null
}

export interface NotificationsResponse {
  items: Notification[]
  unread: number
}

export interface Dictionaries {
  states: { id: number; name: string; enum: string; isActive: boolean; isResolved: boolean }[]
  priorities: { id: number; name: string }[]
  groups: { id: string; title: string }[]
  transitions: Record<string, number[]>
  coordinatorsGroupName: string
  criticalPriorityId: number
  aiEnabled: boolean
  assignedGroups: string[]
  products: string[]
  serviceTypes: string[]
  receivingChannels: string[]
}

export interface StatsResponse {
  serverTime: string
  byState: Record<string, number>
  active: {
    byProduct: Record<string, number>
    byAssignedGroup: Record<string, number>
    byPriority: Record<string, number>
    bySla: Record<string, number>
  }
  resolved: {
    count: number
    avgResolutionMinutes: number | null
    slaMetRate: number | null
  }
}

export interface MyIncidentsResponse {
  serverTime: string
  role: Role
  total: number
  levels: { priorityId: number; title: string; name: string; count: number; items: Card[] }[]
}

export interface WsEnvelope {
  eventId?: string
  type: string
  ts: string
  payload: Record<string, unknown>
}

export interface ToastItem {
  key: string
  tone: 'info' | 'success' | 'warning' | 'critical'
  text: string
  createdAt: number
}

/** Заявка на регистрацию, созданная на экране «Регистрация» (роль назначает администратор). */
export interface PendingUser {
  email: string
  fullName: string
  requestedAt: string
}
