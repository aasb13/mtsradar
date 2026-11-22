/**
 * Клиент REST API. Токены живут в localStorage; при 401 делается один
 * прозрачный refresh и запрос повторяется.
 */

import type {
  BoardResponse,
  ChatSendResponse,
  ChatSessionResponse,
  ChatSessionsResponse,
  Comment,
  Dictionaries,
  DashboardResponse,
  HistoryEvent,
  IncidentDetail,
  IncidentsResponse,
  MyIncidentsResponse,
  NotificationsResponse,
  RegistrationRequest,
  StatsResponse,
  TeamDescriptionsResponse,
  TeamRecommendation,
  TokenPair,
  User,
} from './types'

const ACCESS_KEY = 'radar-access-token'
const REFRESH_KEY = 'radar-refresh-token'

/** «Запомнить меня»: галочка — localStorage (живёт между запусками браузера), без неё — sessionStorage (до закрытия вкладки). */
function tokenStores(): Storage[] {
  const stores: Storage[] = []
  try {
    stores.push(window.localStorage)
  } catch (err) {
    console.error('localStorage недоступен', err)
  }
  try {
    stores.push(window.sessionStorage)
  } catch (err) {
    console.error('sessionStorage недоступен', err)
  }
  return stores
}

export function getAccessToken(): string | null {
  for (const store of tokenStores()) {
    const value = store.getItem(ACCESS_KEY)
    if (value !== null) return value
  }
  return null
}

export function getRefreshToken(): string | null {
  for (const store of tokenStores()) {
    const value = store.getItem(REFRESH_KEY)
    if (value !== null) return value
  }
  return null
}

export function storeTokens(access: string, refresh: string, persist = true): void {
  const store = persist ? window.localStorage : window.sessionStorage
  try {
    store.setItem(ACCESS_KEY, access)
    store.setItem(REFRESH_KEY, refresh)
  } catch (err) {
    console.error('Не удалось сохранить токены', err)
  }
}

export function clearTokens(): void {
  for (const store of tokenStores()) {
    try {
      store.removeItem(ACCESS_KEY)
      store.removeItem(REFRESH_KEY)
    } catch (err) {
      console.error('Не удалось удалить токены', err)
    }
  }
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

interface RequestOptions {
  method?: string
  body?: unknown
  retry?: boolean
}

/** Текст ошибки сервера: FastAPI отдаёт {"detail": "..."}. */
async function errorOf(res: Response): Promise<ApiError> {
  let detail = ''
  try {
    const parsed: unknown = await res.json()
    if (typeof parsed === 'object' && parsed !== null) {
      const d = (parsed as Record<string, unknown>).detail
      if (typeof d === 'string') detail = d
      else if (typeof d === 'object' && d !== null) {
        const msg = (d as Record<string, unknown>).message
        if (typeof msg === 'string') detail = msg
      }
    }
  } catch (err) {
    console.error('Не удалось прочитать тело ошибки', err)
  }
  return new ApiError(res.status, detail || `HTTP ${res.status}`)
}

let refreshing: Promise<boolean> | null = null

async function refreshTokens(): Promise<boolean> {
  refreshing ??= (async () => {
    const refresh = getRefreshToken()
    if (refresh === null) return false
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      })
      if (!res.ok) return false
      const pair = (await res.json()) as TokenPair
      storeTokens(pair.accessToken, pair.refreshToken)
      return true
    } catch (err) {
      console.error('Не удалось обновить токен', err)
      return false
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, retry = true } = options
  const headers: Record<string, string> = {}
  const token = getAccessToken()
  if (token !== null) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    throw new ApiError(0, 'Сервер недоступен')
  }
  if (res.status === 401 && retry && getRefreshToken() !== null) {
    if (await refreshTokens()) return request<T>(path, { ...options, retry: false })
  }
  if (!res.ok) throw await errorOf(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

// ---------------- auth ----------------

export function login(email: string, password: string): Promise<TokenPair> {
  return request<TokenPair>('/auth/login', { method: 'POST', body: { email, password } })
}

/** Заявка на регистрацию: аккаунт появится после одобрения администратором. */
export function register(body: { email: string; password: string; fullName: string }): Promise<RegistrationRequest> {
  return request<RegistrationRequest>('/auth/register', { method: 'POST', body })
}

export function logoutRequest(): Promise<void> {
  const refresh = getRefreshToken()
  if (refresh === null) return Promise.resolve()
  return request<void>('/auth/logout', { method: 'POST', body: { refreshToken: refresh }, retry: false })
    .catch(() => undefined) as Promise<void>
}

export function fetchMe(): Promise<User> {
  return request<User>('/me')
}

export function patchMe(body: Partial<User>): Promise<User> {
  return request<User>('/me', { method: 'PATCH', body })
}

// ---------------- дашборд и канбан ----------------

export function fetchDashboard(): Promise<DashboardResponse> {
  return request<DashboardResponse>('/dashboard')
}

export function fetchBoard(): Promise<BoardResponse> {
  return request<BoardResponse>('/board')
}

export interface IncidentFilters {
  group?: string
  stateId?: number[]
  priorityId?: number[]
  assignedGroupName?: string
  productName?: string
  slaState?: string[]
  active?: boolean
  q?: string
  sort?: 'attention' | 'deadline' | 'submitDate' | 'priority'
  order?: 'asc' | 'desc'
  page?: number
  perPage?: number
}

export function fetchIncidents(filters: IncidentFilters = {}): Promise<IncidentsResponse> {
  const p = new URLSearchParams()
  if (filters.group !== undefined) p.set('group', filters.group)
  for (const s of filters.stateId ?? []) p.append('stateId', String(s))
  for (const v of filters.priorityId ?? []) p.append('priorityId', String(v))
  if (filters.assignedGroupName !== undefined) p.set('assignedGroupName', filters.assignedGroupName)
  if (filters.productName !== undefined) p.set('productName', filters.productName)
  for (const s of filters.slaState ?? []) p.append('slaState', s)
  if (filters.active !== undefined) p.set('active', String(filters.active))
  if (filters.q !== undefined && filters.q !== '') p.set('q', filters.q)
  if (filters.sort !== undefined) p.set('sort', filters.sort)
  if (filters.order !== undefined) p.set('order', filters.order)
  if (filters.page !== undefined) p.set('page', String(filters.page))
  if (filters.perPage !== undefined) p.set('perPage', String(filters.perPage))
  const qs = p.toString()
  return request<IncidentsResponse>(`/incidents${qs === '' ? '' : `?${qs}`}`)
}

export function fetchIncident(id: string): Promise<IncidentDetail> {
  return request<IncidentDetail>(`/incidents/${encodeURIComponent(id)}`)
}

export function patchIncident(
  id: string,
  body: {
    priorityId?: number
    deadline?: string
    assignedGroupName?: string
    assignedEmployee?: string
    header?: string
    expectedVersion?: number
  },
): Promise<IncidentDetail> {
  return request<IncidentDetail>(`/incidents/${encodeURIComponent(id)}`, { method: 'PATCH', body })
}

export function transitionIncident(
  id: string,
  body: { toStateId: number; stateReason?: string; solution?: string; comment?: string },
): Promise<IncidentDetail> {
  return request<IncidentDetail>(`/incidents/${encodeURIComponent(id)}/transition`, { method: 'POST', body })
}

export function ackIncident(id: string): Promise<unknown> {
  return request<unknown>(`/incidents/${encodeURIComponent(id)}/ack`, { method: 'POST' })
}

export function deleteIncident(id: string): Promise<void> {
  return request<void>(`/incidents/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function restoreIncident(id: string): Promise<unknown> {
  return request<unknown>(`/incidents/${encodeURIComponent(id)}/restore`, { method: 'POST' })
}

export function fetchHistory(id: string): Promise<HistoryEvent[]> {
  return request<HistoryEvent[]>(`/incidents/${encodeURIComponent(id)}/history`)
}

export function fetchComments(id: string): Promise<Comment[]> {
  return request<Comment[]>(`/incidents/${encodeURIComponent(id)}/comments`)
}

export function addComment(id: string, text: string): Promise<Comment> {
  return request<Comment>(`/incidents/${encodeURIComponent(id)}/comments`, { method: 'POST', body: { text } })
}

export function addMember(id: string, userId: string): Promise<unknown> {
  return request<unknown>(`/incidents/${encodeURIComponent(id)}/members`, { method: 'POST', body: { userId } })
}

export function requestAiRefresh(id: string): Promise<void> {
  return request<void>(`/incidents/${encodeURIComponent(id)}/ai/refresh`, { method: 'POST' })
}

/** BigDad: рекомендация команды для инцидента (агент работает 10–60 секунд). */
export function requestTeamRecommendation(id: string): Promise<TeamRecommendation> {
  return request<TeamRecommendation>(`/incidents/${encodeURIComponent(id)}/ai/team-recommendation`, { method: 'POST' })
}

// ---------------- ИИ-описания команд (статистика) ----------------

export function fetchTeamDescriptions(): Promise<TeamDescriptionsResponse> {
  return request<TeamDescriptionsResponse>('/ai/team-descriptions')
}

export function refreshTeamDescriptions(): Promise<TeamDescriptionsResponse> {
  return request<TeamDescriptionsResponse>('/ai/team-descriptions', { method: 'POST' })
}

// ---------------- чат с ИИ-агентом BigDad ----------------

export function fetchChatSessions(): Promise<ChatSessionsResponse> {
  return request<ChatSessionsResponse>('/ai/chat/sessions')
}

export function createChatSession(body: {
  firstMessage?: string
  attachmentIds?: string[]
  incidentId?: string
}): Promise<ChatSessionResponse> {
  return request<ChatSessionResponse>('/ai/chat/sessions', { method: 'POST', body })
}

export function fetchChatSession(id: string): Promise<ChatSessionResponse> {
  return request<ChatSessionResponse>(`/ai/chat/sessions/${encodeURIComponent(id)}`)
}

export function deleteChatSession(id: string): Promise<void> {
  return request<void>(`/ai/chat/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function sendChatMessage(
  id: string,
  body: { text: string; attachmentIds?: string[]; replyToMessageId?: string },
): Promise<ChatSendResponse> {
  return request<ChatSendResponse>(`/ai/chat/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', body })
}

/** Вложение чата: multipart, поэтому отдельный fetch (request() умеет только JSON). */
export async function uploadChatFile(file: File, retry = true): Promise<{ id: string; name: string; size: number }> {
  const form = new FormData()
  form.append('file', file)
  let res: Response
  try {
    res = await fetch('/api/ai/chat/uploads', {
      method: 'POST',
      headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
      body: form,
    })
  } catch (err) {
    throw new ApiError(0, 'Сервер недоступен')
  }
  if (res.status === 401 && retry && getRefreshToken() !== null && (await refreshTokens())) {
    return uploadChatFile(file, false)
  }
  if (!res.ok) throw await errorOf(res)
  return (await res.json()) as { id: string; name: string; size: number }
}

/** Скачивание вложения: авторизация заголовком, поэтому blob + временная ссылка. */
export async function downloadChatFile(id: string, name: string, retry = true): Promise<void> {
  let res: Response
  try {
    res = await fetch(`/api/ai/chat/files/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
    })
  } catch (err) {
    throw new ApiError(0, 'Сервер недоступен')
  }
  if (res.status === 401 && retry && getRefreshToken() !== null && (await refreshTokens())) {
    return downloadChatFile(id, name, false)
  }
  if (!res.ok) throw await errorOf(res)
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

// ---------------- пользователи ----------------

export function fetchUsers(): Promise<User[]> {
  return request<User[]>('/users')
}

export function createUser(body: { email: string; password: string; fullName: string; role: string; itsmLogin?: string }): Promise<User> {
  return request<User>('/users', { method: 'POST', body })
}

export function patchUser(id: string, body: { role?: string; fullName?: string; itsmLogin?: string }): Promise<User> {
  return request<User>(`/users/${encodeURIComponent(id)}`, { method: 'PATCH', body })
}

export function deleteUser(id: string): Promise<void> {
  return request<void>(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ---------------- заявки на регистрацию ----------------

export function fetchRegistrationRequests(): Promise<RegistrationRequest[]> {
  return request<RegistrationRequest[]>('/registration-requests')
}

export function approveRegistrationRequest(id: string, role: string, itsmLogin?: string): Promise<User> {
  return request<User>(`/registration-requests/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: { role, itsmLogin: itsmLogin === '' ? undefined : itsmLogin },
  })
}

export function rejectRegistrationRequest(id: string, reason?: string): Promise<RegistrationRequest> {
  return request<RegistrationRequest>(`/registration-requests/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: { reason: reason === '' ? undefined : reason },
  })
}

// ---------------- уведомления ----------------

export function fetchNotifications(unreadOnly = false): Promise<NotificationsResponse> {
  return request<NotificationsResponse>(`/notifications${unreadOnly ? '?unreadOnly=true' : ''}`)
}

export function markNotificationRead(id: string): Promise<void> {
  return request<void>(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' })
}

export function markAllNotificationsRead(): Promise<void> {
  return request<void>('/notifications/read-all', { method: 'POST' })
}

// ---------------- справочники, статистика, мои инциденты ----------------

export function fetchDictionaries(): Promise<Dictionaries> {
  return request<Dictionaries>('/dictionaries')
}

export function fetchStats(): Promise<StatsResponse> {
  return request<StatsResponse>('/stats')
}

export function fetchMyIncidents(includeResolved = false): Promise<MyIncidentsResponse> {
  return request<MyIncidentsResponse>(`/my/incidents${includeResolved ? '?includeResolved=true' : ''}`)
}

export function exportUrl(): string {
  return '/api/export'
}
