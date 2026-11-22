/**
 * Типы контракта с бэкендом ( FastAPI, /api/* ). Зеркало ответов сервера:
 * presenter.card / presenter.detail, /auth, /users, /notifications,
 * /dictionaries, /stats, /my/incidents, события WebSocket.
 */

export type Role = 'admin' | 'coordinator' | 'viewer' | 'developer'

/** Русские названия ролей — общие для админки, чата и регистрации по приглашению. */
export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Администратор',
  coordinator: 'Координатор',
  developer: 'Разработчик',
  viewer: 'Тестировщик',
}

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

/** Серверная заморозка SLA: null — не заморожен, объект — идёт пауза. */
export interface CardFreeze {
  startedAt: string
  endsAt: string | null
  reason: string
  actor: { id?: string; name?: string | null } | null
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
  freeze?: CardFreeze | null
  acknowledged: { userId: string; name?: string | null; at: string } | null
  /** Координатор, на которого инцидент распределён при появлении; doneAt — когда передали команде. */
  routedTo: { userId: string; name?: string | null; at: string; doneAt?: string | null } | null
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

/** Настройки уведомлений пользователя: каналы + включённые виды событий. */
export interface NotificationSettings {
  inApp: boolean
  push: boolean
  telegram: boolean
  email: boolean
  kinds: Record<string, boolean>
}

export interface User {
  id: string
  email: string
  fullName: string | null
  role: Role
  itsmLogin: string | null
  team: string | null
  telegramChatId: string | null
  notificationSettings: NotificationSettings
  createdAt: string | null
  deletedAt: string | null
}

/** GET /me: пользователь + справочник видов уведомлений (kind → русское название). */
export interface MeResponse extends User {
  notificationKinds: Record<string, string>
}

/** PATCH /me: правки своего профиля; пароль меняется парой с текущим. */
export interface MePatch {
  fullName?: string
  telegramChatId?: string | null
  notificationSettings?: NotificationSettings
  currentPassword?: string
  newPassword?: string
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
  /** команды, созданные администратором и живущие в базе (в отличие от выведенных из инцидентов) */
  customTeams: string[]
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

/** GET /my/tasks: инциденты, в которых участвует текущий пользователь (учитывает роль). */
export interface MyTasksResponse {
  serverTime: string
  role: Role
  total: number
  items: Card[]
}

/** Оценка сотрудника: 1–5 звёзд с комментарием; автор скрыт у анонимных отзывов. */
export interface RatingItem {
  id: string
  score: number
  comment: string
  createdAt: string
  anonymous: boolean
  author: { id: string; name: string } | null
}

export interface RatingsResponse {
  userId: string
  average: number | null
  count: number
  distribution: Record<string, number>
  items: RatingItem[]
}

export interface RatingLeaderboardItem {
  userId: string
  fullName: string
  role: Role
  team: string | null
  average: number | null
  count: number
}

export interface RatingLeaderboardResponse {
  items: RatingLeaderboardItem[]
}

/** Участник команды: аккаунт в системе или исполнитель, известный только из ITSM. */
export interface TeamMember {
  id: string | null
  name: string
  email: string | null
  itsmLogin: string | null
  role: Role | null
  kind: 'account' | 'executor'
  active: number
  done: number
  rating: { average: number; count: number } | null
}

/** GET /teams/{name}/profile — профиль команды целиком. */
export interface TeamProfileResponse {
  name: string
  serverTime: string
  createdAt: string | null
  members: TeamMember[]
  assigned: Card[]
  done: Card[]
  /** Среднее по всем оценкам участников команды, а не среднее их средних. */
  rating: { average: number | null; count: number; ratedMembers: number }
}

// ---------------- чат с ИИ-агентом BigDad ----------------

export interface ChatAttachment {
  id: string
  name: string
  size: number
}

export interface ChatActionTrace {
  tool: string
  ok: boolean
  summary: string
}

export interface ChatReplyTo {
  messageId: string
  snippet: string
}

export interface ChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  text: string
  attachments: ChatAttachment[]
  replyTo: ChatReplyTo | null
  actions: ChatActionTrace[]
  createdAt: string
}

export interface ChatSession {
  id: string
  title: string
  incidentId: string | null
  createdAt: string
  updatedAt: string
}

export interface ChatSessionsResponse {
  items: ChatSession[]
}

export interface ChatSessionResponse {
  session: ChatSession
  messages: ChatMessage[]
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
  /** Момент начала исчезновения: тост доигрывает анимацию exit и ещё висит в списке. */
  leavingAt?: number
  /** Инцидент, о котором сообщает уведомление: клик ведёт на канбан инцидентов. */
  incidentId?: string
}

/** Заявка на регистрацию: хранится на сервере до решения администратора. */
export interface RegistrationRequest {
  id: string
  email: string
  fullName: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string | null
  decidedAt: string | null
  role: Role | null
  itsmLogin: string | null
}

/** Одноразовое приглашение на ветку: живёт в Redis до регистрации, отзыва или конца TTL. */
export interface Invite {
  token: string
  role: Role
  itsmLogin: string | null
  createdAt: string | null
  expiresAt: string | null
}
