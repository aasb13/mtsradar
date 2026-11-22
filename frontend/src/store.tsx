import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import type { Dispatch, ReactNode } from 'react'
import * as api from './api'
import { ApiError, clearTokens, getAccessToken, getRefreshToken, storeTokens } from './api'
import { beepCritical } from './beep'
import { FEED_TEXT, isUnassigned, pluralize } from './format'
import { currentPath, incidentIdFromPath, incidentPath, incidentReturnPath, navigate, nextIncidentPath } from './router'
import { connectSocket } from './ws'
import type {
  Card,
  Comment,
  DashboardResponse,
  Dictionaries,
  IncidentDetail,
  Notification,
  RegistrationRequest,
  StatsResponse,
  ToastItem,
  TokenPair,
  User,
  WsEnvelope,
} from './types'
import { ASSIGNED, IN_PROGRESS, RESEARCH } from './types'

export type ConnectionState = 'connecting' | 'online' | 'reconnecting'
export type Theme = 'light' | 'dark'

/** Тело запроса заморозки; время разморозки по расписанию — ISO-строка. */
export interface FreezeRequest {
  reason: string
  comment?: string
  autoUnfreezeAt?: string
}

interface State {
  user: User | null
  authError: string | null
  authInProgress: boolean
  // true, пока при старте проверяется сохранённая сессия — чтобы не мигать логином
  authChecking: boolean
  connection: ConnectionState
  bootError: string | null
  cards: Map<string, Card>
  cardsOrder: string[]
  syncedAt: number | null
  kpi: DashboardResponse['kpi'] | null
  unacknowledgedCritical: string[]
  dictionaries: Dictionaries | null
  stats: StatsResponse | null
  resolvedYesterday: number
  coordinatorCount: number
  notifications: Notification[]
  unread: number
  // заявка, только что отправленная с экрана регистрации (для страницы «На рассмотрении»)
  pendingRequest: RegistrationRequest | null
  toasts: ToastItem[]
  search: string
  theme: Theme
  filters: {
    priorityId: number | null
    product: string | null
    team: string | null
    sla: string | null
    status: StatusFilter | null
  }
  panelId: string | null
  assignId: string | null
  freezeId: string | null
  now: number
}

/** Ключи фильтра статуса «Ваших инцидентов»: что видно в колонках при активных инцидентах. */
export type StatusFilter = 'unassigned' | 'assigned' | 'progress' | 'research'

const THEME_KEY = 'radar-theme'
// локальные записи администратора: серверный справочник выводится из инцидентов,
// поэтому добавленные до первого инцидента продукты/команды живут здесь
const LOCAL_PRODUCTS_KEY = 'radar-local-products'
const LOCAL_TEAMS_KEY = 'radar-local-teams'
// удалённые из справочника значения: сервер выводит их из инцидентов заново при каждом
// запросе, поэтому скрытие живёт тоже в localStorage, а не в данных инцидентов
const LOCAL_REMOVED_PRODUCTS_KEY = 'radar-removed-products'
const LOCAL_REMOVED_TEAMS_KEY = 'radar-removed-teams'

function localList(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? [] : (JSON.parse(raw) as string[])
  } catch {
    return []
  }
}

function dictWithLocalItems(dictionaries: Dictionaries): Dictionaries {
  const removedProducts = localList(LOCAL_REMOVED_PRODUCTS_KEY)
  const removedTeams = localList(LOCAL_REMOVED_TEAMS_KEY)
  return {
    ...dictionaries,
    products: [...new Set([...dictionaries.products.filter(x => !removedProducts.includes(x)), ...localList(LOCAL_PRODUCTS_KEY)])].sort(),
    assignedGroups: [
      ...new Set([...dictionaries.assignedGroups.filter(x => !removedTeams.includes(x)), ...localList(LOCAL_TEAMS_KEY)]),
    ].sort(),
  }
}

const TOAST_LIMIT = 4

function makeInitialState(): State {
  let theme: Theme = 'light'
  try {
    if (window.localStorage.getItem(THEME_KEY) === 'dark') theme = 'dark'
  } catch (err) {
    console.error('Не удалось прочитать тему', err)
  }
  return {
    user: null,
    authError: null,
    authInProgress: false,
    authChecking: getAccessToken() !== null || getRefreshToken() !== null,
    connection: 'connecting',
    bootError: null,
    cards: new Map(),
    cardsOrder: [],
    syncedAt: null,
    kpi: null,
    unacknowledgedCritical: [],
    dictionaries: null,
    stats: null,
    resolvedYesterday: 0,
    coordinatorCount: 1,
    notifications: [],
    unread: 0,
    pendingRequest: null,
    toasts: [],
    search: '',
    theme,
    filters: { priorityId: null, product: null, team: null, sla: null, status: null },
    panelId: null,
    assignId: null,
    freezeId: null,
    now: Date.now(),
  }
}

export type Action =
  | { type: 'AUTH_START' }
  | { type: 'AUTH_SUCCESS'; user: User }
  | { type: 'SET_USER'; user: User }
  | { type: 'AUTH_FAIL'; message: string }
  | { type: 'AUTH_CHECKED' }
  | { type: 'AUTH_LOGOUT' }
  | { type: 'BOOT_OK'; cards: Card[]; dashboard: DashboardResponse; dictionaries: Dictionaries }
  | { type: 'SET_DICTIONARIES'; dictionaries: Dictionaries }
  | { type: 'ADD_DICT_ITEMS'; field: 'products' | 'assignedGroups'; items: string[] }
  | { type: 'RESTORE_DICT_ITEM'; field: 'products' | 'assignedGroups'; name: string }
  | { type: 'RENAME_DICT_ITEM'; field: 'products' | 'assignedGroups'; from: string; to: string }
  | { type: 'REMOVE_DICT_ITEM'; field: 'products' | 'assignedGroups'; name: string }
  | { type: 'BOOT_FAIL'; message: string }
  | { type: 'UPSERT_CARDS'; cards: Card[] }
  | { type: 'REMOVE_CARD'; id: string }
  | { type: 'SET_KPI'; kpi: DashboardResponse['kpi']; unacknowledgedCritical: string[] }
  | { type: 'SET_STATS'; stats: StatsResponse }
  | { type: 'SET_RESOLVED_YESTERDAY'; count: number }
  | { type: 'SET_COORDINATOR_COUNT'; count: number }
  | { type: 'CONN'; state: ConnectionState }
  | { type: 'TICK'; now: number }
  | { type: 'SET_SEARCH'; search: string }
  | { type: 'SET_THEME'; theme: Theme }
  | { type: 'SET_FILTERS'; patch: Partial<State['filters']> }
  | { type: 'SET_NOTIFICATIONS'; items: Notification[]; unread: number }
  | { type: 'MARK_NOTIFICATIONS_READ'; ids: string[] | null }
  | { type: 'ADD_NOTIFICATION'; notification: Notification }
  | { type: 'ACK_CRITICAL'; id: string }
  | { type: 'SET_PENDING_REQUEST'; request: RegistrationRequest | null }
  | { type: 'ADD_TOAST'; toast: ToastItem }
  | { type: 'DISMISS_TOAST'; key: string }
  | { type: 'REMOVE_TOAST'; key: string }
  | { type: 'OPEN_PANEL'; id: string | null }
  | { type: 'OPEN_ASSIGN'; id: string | null }
  | { type: 'OPEN_FREEZE'; id: string | null }

function toast(state: State, item: ToastItem): State {
  return { ...state, toasts: [...state.toasts.filter(t => t.key !== item.key), item].slice(-TOAST_LIMIT) }
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'AUTH_START':
      return { ...state, authInProgress: true, authError: null }
    case 'AUTH_SUCCESS':
      return { ...state, user: action.user, authInProgress: false, authError: null, authChecking: false, bootError: null }
    case 'SET_USER':
      return { ...state, user: action.user }
    case 'AUTH_FAIL':
      return { ...state, authInProgress: false, authError: action.message }
    case 'AUTH_CHECKED':
      return { ...state, authChecking: false }
    case 'AUTH_LOGOUT':
      return { ...makeInitialState(), theme: state.theme }
    case 'BOOT_OK': {
      const cards = new Map(state.cards)
      const order: string[] = []
      for (const card of action.cards) {
        cards.set(card.id, card)
        order.push(card.id)
      }
      for (const id of state.cardsOrder) if (!order.includes(id)) order.push(id)
      return {
        ...state,
        cards,
        cardsOrder: [...order, ...state.cardsOrder.filter(id => !order.includes(id))],
        syncedAt: Date.now(),
        kpi: action.dashboard.kpi,
        unacknowledgedCritical: action.dashboard.unacknowledgedCritical,
        dictionaries: dictWithLocalItems(action.dictionaries),
        bootError: null,
      }
    }
    case 'SET_DICTIONARIES':
      return { ...state, dictionaries: dictWithLocalItems(action.dictionaries) }
    case 'ADD_DICT_ITEMS': {
      const key = action.field === 'products' ? LOCAL_PRODUCTS_KEY : LOCAL_TEAMS_KEY
      const values = action.items.filter(x => x !== '' && x !== 'null')
      try {
        window.localStorage.setItem(key, JSON.stringify([...new Set([...localList(key), ...values])]))
      } catch (err) {
        console.error('Не удалось сохранить список', err)
      }
      if (state.dictionaries === null) return state
      const merged = [...new Set([...state.dictionaries[action.field], ...values])].sort()
      return { ...state, dictionaries: { ...state.dictionaries, [action.field]: merged } }
    }
    case 'RESTORE_DICT_ITEM': {
      // значение снова есть на сервере (команду создали заново после удаления):
      // убираем его из локального списка скрытых, чтобы оно показывалось и здесь
      const removedKey = action.field === 'products' ? LOCAL_REMOVED_PRODUCTS_KEY : LOCAL_REMOVED_TEAMS_KEY
      try {
        window.localStorage.setItem(removedKey, JSON.stringify(localList(removedKey).filter(x => x !== action.name)))
      } catch (err) {
        console.error('Не удалось сохранить список', err)
      }
      if (state.dictionaries === null) return state
      const restored = [...new Set([...state.dictionaries[action.field], action.name])].sort()
      return { ...state, dictionaries: { ...state.dictionaries, [action.field]: restored } }
    }
    case 'RENAME_DICT_ITEM': {
      // инциденты переименовывает запрос (doRenameDictItem); здесь — локальные записи и текущий список
      const key = action.field === 'products' ? LOCAL_PRODUCTS_KEY : LOCAL_TEAMS_KEY
      const list = localList(key)
      if (list.includes(action.from)) {
        try {
          window.localStorage.setItem(key, JSON.stringify(list.map(x => (x === action.from ? action.to : x))))
        } catch (err) {
          console.error('Не удалось сохранить список', err)
        }
      }
      if (state.dictionaries === null) return state
      const renamed = [...new Set(state.dictionaries[action.field].map(x => (x === action.from ? action.to : x)))].sort()
      return { ...state, dictionaries: { ...state.dictionaries, [action.field]: renamed } }
    }
    case 'REMOVE_DICT_ITEM': {
      const key = action.field === 'products' ? LOCAL_PRODUCTS_KEY : LOCAL_TEAMS_KEY
      const removedKey = action.field === 'products' ? LOCAL_REMOVED_PRODUCTS_KEY : LOCAL_REMOVED_TEAMS_KEY
      try {
        window.localStorage.setItem(key, JSON.stringify(localList(key).filter(x => x !== action.name)))
        window.localStorage.setItem(removedKey, JSON.stringify([...new Set([...localList(removedKey), action.name])]))
      } catch (err) {
        console.error('Не удалось сохранить список', err)
      }
      const filters =
        action.field === 'products'
          ? { ...state.filters, product: state.filters.product === action.name ? null : state.filters.product }
          : { ...state.filters, team: state.filters.team === action.name ? null : state.filters.team }
      if (state.dictionaries === null) return { ...state, filters }
      const remaining = state.dictionaries[action.field].filter(x => x !== action.name)
      return { ...state, filters, dictionaries: { ...state.dictionaries, [action.field]: remaining } }
    }
    case 'BOOT_FAIL':
      return { ...state, bootError: action.message }
    case 'UPSERT_CARDS': {
      const cards = new Map(state.cards)
      for (const card of action.cards) cards.set(card.id, card)
      return { ...state, cards, syncedAt: Date.now() }
    }
    case 'REMOVE_CARD': {
      const cards = new Map(state.cards)
      cards.delete(action.id)
      return { ...state, cards }
    }
    case 'SET_KPI':
      return { ...state, kpi: action.kpi, unacknowledgedCritical: action.unacknowledgedCritical }
    case 'SET_STATS':
      return { ...state, stats: action.stats }
    case 'SET_RESOLVED_YESTERDAY':
      return { ...state, resolvedYesterday: action.count }
    case 'SET_COORDINATOR_COUNT':
      return { ...state, coordinatorCount: action.count }
    case 'CONN':
      return { ...state, connection: action.state }
    case 'TICK':
      return { ...state, now: action.now }
    case 'SET_SEARCH':
      return { ...state, search: action.search }
    case 'SET_THEME':
      return { ...state, theme: action.theme }
    case 'SET_FILTERS':
      return { ...state, filters: { ...state.filters, ...action.patch } }
    case 'SET_NOTIFICATIONS':
      return { ...state, notifications: action.items, unread: action.unread }
    case 'MARK_NOTIFICATIONS_READ': {
      const ids = action.ids === null ? null : new Set(action.ids)
      const at = new Date().toISOString()
      const notifications = state.notifications.map(n =>
        n.readAt === null && (ids === null || ids.has(n.id)) ? { ...n, readAt: at } : n,
      )
      // сервер считает unread по всей коллекции, список в памяти ограничен 50 записями
      const markedVisible = state.notifications.filter(n => n.readAt === null && (ids === null || ids.has(n.id))).length
      const unread = ids === null ? 0 : Math.max(0, state.unread - markedVisible)
      return { ...state, notifications, unread }
    }
    case 'ACK_CRITICAL':
      return { ...state, unacknowledgedCritical: state.unacknowledgedCritical.filter(id => id !== action.id) }
    case 'ADD_NOTIFICATION':
      return {
        ...state,
        notifications: [action.notification, ...state.notifications].slice(0, 50),
        unread: action.notification.readAt === null ? state.unread + 1 : state.unread,
      }
    case 'SET_PENDING_REQUEST':
      return { ...state, pendingRequest: action.request }
    case 'ADD_TOAST':
      return toast(state, action.toast)
    case 'DISMISS_TOAST':
      // не удаляем сразу: тост сначала доигрывает анимацию выхода, REMOVE_TOAST убирает его из DOM
      return {
        ...state,
        toasts: state.toasts.map(t => (t.key === action.key && t.leavingAt === undefined ? { ...t, leavingAt: Date.now() } : t)),
      }
    case 'REMOVE_TOAST':
      return { ...state, toasts: state.toasts.filter(t => t.key !== action.key) }
    case 'OPEN_PANEL':
      return { ...state, panelId: action.id }
    case 'OPEN_ASSIGN':
      return { ...state, assignId: action.id }
    case 'OPEN_FREEZE':
      return { ...state, freezeId: action.id }
    default: {
      const never: never = action
      void never
      return state
    }
  }
}

function isCardPayloadCard(value: unknown): value is Card {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.stateId === 'number' && Array.isArray(o.groups)
}

function cardFrom(value: unknown): Card | null {
  return isCardPayloadCard(value) ? value : null
}

/** Сервер присылает документ уведомления прямо в payload события notification.created. */
function isNotificationPayload(value: unknown): value is Notification {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.kind === 'string' && typeof o.createdAt === 'string'
}

function notificationFrom(value: unknown): Notification | null {
  if (!isNotificationPayload(value)) return null
  return {
    id: value.id,
    userId: typeof value.userId === 'string' ? value.userId : '',
    kind: value.kind,
    title: typeof value.title === 'string' ? value.title : null,
    body: typeof value.body === 'string' ? value.body : null,
    incidentId: typeof value.incidentId === 'string' ? value.incidentId : null,
    createdAt: value.createdAt,
    readAt: typeof value.readAt === 'string' ? value.readAt : null,
  }
}

interface AppContextValue {
  state: State
  dispatch: Dispatch<Action>
  login: (email: string, password: string, remember?: boolean) => Promise<void>
  /** Сессия получена вне входа (регистрация по приглашению) — сохраняем токены и входим. */
  loginWithPair: (pair: TokenPair, remember?: boolean) => Promise<void>
  logout: () => Promise<void>
  register: (email: string, password: string, fullName: string) => Promise<RegistrationRequest>
  refreshDashboard: () => Promise<void>
  refreshBoard: () => Promise<void>
  refreshStats: () => Promise<void>
  refreshDictionaries: () => Promise<void>
  doTransition: (card: Card, toStateId: number, extra?: { stateReason?: string; solution?: string; comment?: string }) => Promise<boolean>
  doAck: (id: string) => Promise<void>
  doAssign: (card: Card, team: string, executorUserId: string | null) => Promise<boolean>
  doFreeze: (id: string, body: FreezeRequest) => Promise<boolean>
  doUnfreeze: (id: string) => Promise<boolean>
  /** Переименование продукта/команды: все инциденты со старым значением обновляются запросами. */
  doRenameDictItem: (field: 'products' | 'assignedGroups', from: string, to: string) => Promise<boolean>
  /** Открыть карточку и записать её адрес в строку браузера, чтобы ссылкой можно было поделиться. */
  openIncident: (id: string) => void
  closeIncident: () => void
  showToast: (text: string, tone?: ToastItem['tone'], incidentId?: string) => void
}

const AppContext = createContext<AppContextValue | null>(null)

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (ctx === null) throw new Error('useApp должен вызываться внутри AppProvider')
  return ctx
}

const DASHBOARD_REFRESH_DEBOUNCE_MS = 400

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, null, makeInitialState)
  const stateRef = useRef(state)
  stateRef.current = state

  const showToast = useCallback((text: string, tone: ToastItem['tone'] = 'info', incidentId?: string) => {
    const toast: ToastItem = { key: `${Date.now()}|${Math.random()}|${text}`, tone, text, createdAt: Date.now() }
    if (incidentId !== undefined && incidentId !== '') toast.incidentId = incidentId
    dispatch({ type: 'ADD_TOAST', toast })
  }, [])

  const openIncident = useCallback((id: string) => {
    const from = currentPath()
    // уже открытая карточка: сохраняем экран, откуда пришли в неё в первый раз
    const back = incidentIdFromPath(from) === null ? from : incidentReturnPath() ?? '/'
    dispatch({ type: 'OPEN_PANEL', id })
    navigate(incidentPath(id), false, { radarReturn: back })
  }, [])

  const closeIncident = useCallback(() => {
    dispatch({ type: 'OPEN_PANEL', id: null })
    navigate(incidentReturnPath() ?? '/', true)
  }, [])

  // тикающие часы для живых SLA-таймеров
  useEffect(() => {
    const timer = window.setInterval(() => dispatch({ type: 'TICK', now: Date.now() }), 1000)
    return () => window.clearInterval(timer)
  }, [])

  // тема
  useEffect(() => {
    document.documentElement.dataset.theme = state.theme
    try {
      window.localStorage.setItem(THEME_KEY, state.theme)
    } catch (err) {
      console.error('Не удалось сохранить тему', err)
    }
  }, [state.theme])

  // заявка уходит на сервер и живёт там до решения администратора
  const register = useCallback(async (email: string, password: string, fullName: string) => {
    const request = await api.register({ email, password, fullName })
    dispatch({ type: 'SET_PENDING_REQUEST', request })
    return request
  }, [])

  const refreshDashboard = useCallback(async () => {
    try {
      const dashboard = await api.fetchDashboard()
      dispatch({ type: 'SET_KPI', kpi: dashboard.kpi, unacknowledgedCritical: dashboard.unacknowledgedCritical })
      const groups = Object.values(dashboard.groups).flat()
      if (groups.length > 0) dispatch({ type: 'UPSERT_CARDS', cards: groups })
    } catch (err) {
      console.error('Не удалось обновить дашборд', err)
    }
  }, [])

  const refreshBoard = useCallback(async () => {
    try {
      const board = await api.fetchBoard()
      const cards = board.columns.flatMap(c => c.cards)
      dispatch({ type: 'UPSERT_CARDS', cards })
    } catch (err) {
      console.error('Не удалось обновить доску', err)
    }
  }, [])

  const refreshDictionaries = useCallback(async () => {
    try {
      dispatch({ type: 'SET_DICTIONARIES', dictionaries: await api.fetchDictionaries() })
    } catch (err) {
      console.error('Не удалось обновить справочники', err)
    }
  }, [])

  const refreshStats = useCallback(async () => {
    try {
      const stats = await api.fetchStats()
      dispatch({ type: 'SET_STATS', stats })
      const resolved = await api.fetchIncidents({ stateId: [7, 10], perPage: 500 })
      dispatch({ type: 'UPSERT_CARDS', cards: resolved.items })
      const dayMs = 86400000
      const dayStart = new Date()
      dayStart.setHours(0, 0, 0, 0)
      const yesterdayStart = dayStart.getTime() - dayMs
      const count = resolved.items.filter(c => {
        const t = c.completionDate === null ? NaN : Date.parse(c.completionDate)
        return !Number.isNaN(t) && t >= yesterdayStart && t < dayStart.getTime()
      }).length
      dispatch({ type: 'SET_RESOLVED_YESTERDAY', count })
    } catch (err) {
      console.error('Не удалось обновить статистику', err)
    }
  }, [])

  // счётчик координаторов в шапке: пересчитываем по событию user.changed и при переподключении
  const refreshCoordinatorCount = useCallback(async () => {
    try {
      const all = await api.fetchUsers()
      dispatch({
        type: 'SET_COORDINATOR_COUNT',
        count: all.filter(u => u.role === 'coordinator' && u.deletedAt === null).length,
      })
    } catch (err) {
      console.error('Не удалось загрузить пользователей', err)
    }
  }, [])

  const dashboardTimer = useRef<number | null>(null)
  const scheduleDashboardRefresh = useCallback(() => {
    if (dashboardTimer.current !== null) return
    dashboardTimer.current = window.setTimeout(() => {
      dashboardTimer.current = null
      void refreshDashboard()
    }, DASHBOARD_REFRESH_DEBOUNCE_MS)
  }, [refreshDashboard])

  // Один общий сигнал об изменении инцидентов: экраны с локальными списками
  // перезагружают свои данные, не имея собственной подписки на WebSocket.
  const incidentChangedTimer = useRef<number | null>(null)
  const scheduleIncidentChanged = useCallback(() => {
    if (incidentChangedTimer.current !== null) return
    incidentChangedTimer.current = window.setTimeout(() => {
      incidentChangedTimer.current = null
      window.dispatchEvent(new CustomEvent('radar:incident-changed'))
    }, 250)
  }, [])

  // справочник продуктов/команд выводится из инцидентов на сервере
  const dictionariesTimer = useRef<number | null>(null)
  const scheduleDictionariesRefresh = useCallback(() => {
    if (dictionariesTimer.current !== null) return
    dictionariesTimer.current = window.setTimeout(() => {
      dictionariesTimer.current = null
      void refreshDictionaries()
    }, 300)
  }, [refreshDictionaries])

  const statsTimer = useRef<number | null>(null)
  const scheduleStatsRefresh = useCallback(() => {
    if (statsTimer.current !== null) return
    statsTimer.current = window.setTimeout(() => {
      statsTimer.current = null
      void refreshStats()
    }, 800)
  }, [refreshStats])

  useEffect(
    () => () => {
      if (incidentChangedTimer.current !== null) window.clearTimeout(incidentChangedTimer.current)
      if (dictionariesTimer.current !== null) window.clearTimeout(dictionariesTimer.current)
      if (statsTimer.current !== null) window.clearTimeout(statsTimer.current)
      if (dashboardTimer.current !== null) window.clearTimeout(dashboardTimer.current)
    },
    [],
  )

  const boot = useCallback(
    async (user: User) => {
      dispatch({ type: 'AUTH_SUCCESS', user })
      // дашборд+справочники — минимум для первого экрана; остальное идёт параллельно
      const base = Promise.all([api.fetchDashboard(), api.fetchDictionaries()])
      const notifications = api
        .fetchNotifications()
        .then(items => dispatch({ type: 'SET_NOTIFICATIONS', items: items.items, unread: items.unread }))
        .catch(err => console.error('Не удалось загрузить уведомления', err))
      const users = refreshCoordinatorCount()
      try {
        const [dashboard, dictionaries] = await base
        const groups = Object.values(dashboard.groups).flat()
        dispatch({
          type: 'BOOT_OK',
          cards: groups,
          dashboard,
          dictionaries,
        })
        await Promise.all([notifications, users])
        void refreshBoard()
        void refreshStats()
      } catch (err) {
        console.error('Не удалось загрузить данные', err)
        dispatch({ type: 'BOOT_FAIL', message: 'Не удалось загрузить данные дашборда' })
      }
    },
    [refreshBoard, refreshStats, refreshCoordinatorCount],
  )

  // восстановление сессии при старте
  useEffect(() => {
    const token = getAccessToken()
    const refresh = getRefreshToken()
    if (token === null && refresh === null) return
    void (async () => {
      try {
        const user = await api.fetchMe()
        await boot(user)
      } catch (err) {
        console.error('Сессия недействительна', err)
        clearTokens()
        dispatch({ type: 'AUTH_CHECKED' })
      }
    })()
    // boot стабилен: ссылочные колбэки
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // WebSocket живёт, пока есть пользователь
  const user = state.user
  useEffect(() => {
    if (user === null) return
    const dispose = connectSocket({
      onState: connection => dispatch({ type: 'CONN', state: connection }),
      onReconnected: () => {
        void refreshDashboard()
        void refreshBoard()
        void refreshCoordinatorCount()
        void refreshDictionaries()
        void refreshStats()
        void api
          .fetchNotifications()
          .then(res => dispatch({ type: 'SET_NOTIFICATIONS', items: res.items, unread: res.unread }))
          .catch(err => console.error('Не удалось обновить уведомления', err))
      },
      onEvent: (event: WsEnvelope) => {
        const payload = event.payload
        if (event.type.startsWith('incident.') && event.type !== 'incident.comment_added') {
          scheduleIncidentChanged()
        }
        switch (event.type) {
          case 'incident.created':
          case 'incident.updated':
          case 'incident.ai_updated':
          case 'incident.sla':
          case 'incident.acknowledged': {
            const card = cardFrom(payload.card)
            if (card !== null) {
              dispatch({ type: 'UPSERT_CARDS', cards: [card] })
              scheduleDashboardRefresh()
            }
            if (event.type === 'incident.created' || event.type === 'incident.updated') {
              scheduleDictionariesRefresh()
            }
            if (event.type === 'incident.created') {
              showToast(`${card?.id ?? ''} — ${FEED_TEXT[event.type] ?? 'событие'}`, 'info', card?.id)
            }
            if (event.type === 'incident.ai_updated') {
              showToast('BigDad обновил анализ инцидента', 'info', card?.id)
              window.dispatchEvent(
                new CustomEvent('radar:incident-ai', {
                  detail: { incidentId: String(payload.incidentId ?? card?.id ?? ''), ai: payload.ai ?? null },
                }),
              )
            }
            break
          }
          case 'incident.frozen':
          case 'incident.unfrozen': {
            const card = cardFrom(payload.card)
            if (card !== null) {
              dispatch({ type: 'UPSERT_CARDS', cards: [card] })
              scheduleDashboardRefresh()
            }
            const id = String(payload.incidentId ?? card?.id ?? '')
            if (event.type === 'incident.frozen') {
              showToast(`${id} заморожен — SLA-таймер на паузе`, 'info', id)
            } else if (payload.auto === true) {
              showToast(`${id} разморожен по расписанию`, 'info', id)
            } else {
              showToast(`${id} разморожен`, 'info', id)
            }
            break
          }
          case 'incident.members_changed': {
            const card = cardFrom(payload.card)
            if (card !== null) {
              dispatch({ type: 'UPSERT_CARDS', cards: [card] })
              scheduleDashboardRefresh()
            }
            break
          }
          case 'incident.removed':
            dispatch({ type: 'REMOVE_CARD', id: String(payload.incidentId ?? '') })
            scheduleDashboardRefresh()
            break
          case 'incident.comment_added': {
            const comment = payload.comment as Comment | undefined
            if (comment !== undefined) {
              window.dispatchEvent(new CustomEvent('radar:comment', { detail: comment }))
            }
            break
          }
          case 'notification.created': {
            const notification = notificationFrom(payload)
            if (notification !== null) {
              dispatch({ type: 'ADD_NOTIFICATION', notification })
              if (notification.body !== null && notification.body !== '') {
                showToast(notification.body, 'info', notification.incidentId ?? undefined)
              }
            }
            break
          }
          case 'registration.created':
          case 'registration.decided':
            // заявки на регистрацию: открытый раздел «Пользователи» перезагружает список
            window.dispatchEvent(new CustomEvent('radar:registration'))
            break
          case 'user.changed': {
            // состав пользователей изменился: сервер считает координаторов сам, доверяем его числу
            const count = payload.coordinatorCount
            if (typeof count === 'number' && Number.isFinite(count)) {
              dispatch({ type: 'SET_COORDINATOR_COUNT', count })
            }
            const changed = payload.user
            if (typeof changed === 'object' && changed !== null && typeof (changed as User).id === 'string') {
              const updated = changed as User
              if (stateRef.current.user?.id === updated.id) {
                dispatch({ type: 'SET_USER', user: { ...stateRef.current.user, ...updated } })
              }
              window.dispatchEvent(new CustomEvent('radar:users-changed', { detail: updated }))
            }
            break
          }
          case 'team.changed':
            // состав команд (создана/переименована/удалена): перечитываем справочник
            // и обновляем открытый профиль команды
            void refreshDictionaries()
            window.dispatchEvent(new CustomEvent('radar:team-changed'))
            break
          case 'chat.updated':
            // чат с BigDad: открытый экран чата дополняет сообщения, список сессий обновляется
            window.dispatchEvent(new CustomEvent('radar:chat', { detail: payload }))
            break
          case 'import.completed':
            showToast('Данные обновлены из файла инцидентов', 'success')
            void refreshBoard()
            scheduleDashboardRefresh()
            scheduleDictionariesRefresh()
            scheduleStatsRefresh()
            break
          case 'import.failed':
            showToast('Не удалось импортировать данные файла', 'critical')
            break
          default:
            break
        }
      },
    })
    return dispose
  }, [user, refreshDashboard, refreshBoard, refreshStats, refreshDictionaries, refreshCoordinatorCount, scheduleDashboardRefresh, scheduleIncidentChanged, scheduleDictionariesRefresh, scheduleStatsRefresh, showToast])

  const loginWithPair = useCallback(
    async (pair: TokenPair, remember = true) => {
      storeTokens(pair.accessToken, pair.refreshToken, remember)
      await boot(pair.user)
      const next = nextIncidentPath()
      navigate(next ?? (pair.user.role === 'developer' ? '/dev' : pair.user.role === 'viewer' ? '/qa' : '/'))
    },
    [boot],
  )

  const login = useCallback(
    async (email: string, password: string, remember = true) => {
      dispatch({ type: 'AUTH_START' })
      try {
        const pair = await api.login(email, password)
        await loginWithPair(pair, remember)
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          dispatch({ type: 'AUTH_FAIL', message: 'Неверная почта или пароль' })
        } else if (err instanceof ApiError && (err.status === 403 || err.status === 429)) {
          dispatch({ type: 'AUTH_FAIL', message: err.message })
        } else {
          console.error('Ошибка входа', err)
          dispatch({ type: 'AUTH_FAIL', message: 'Сервер недоступен. Попробуйте ещё раз.' })
        }
      }
    },
    [loginWithPair],
  )

  const logout = useCallback(async () => {
    try {
      await api.logoutRequest()
    } catch (err) {
      console.error('Не удалось выйти', err)
    }
    clearTokens()
    dispatch({ type: 'AUTH_LOGOUT' })
    navigate('/login')
  }, [])

  const doTransition = useCallback(
    async (card: Card, toStateId: number, extra?: { stateReason?: string; solution?: string; comment?: string }) => {
      try {
        const detail: IncidentDetail = await api.transitionIncident(card.id, { toStateId, ...extra })
        dispatch({ type: 'UPSERT_CARDS', cards: [detail] })
        scheduleDashboardRefresh()
        scheduleIncidentChanged()
        return true
      } catch (err) {
        if (err instanceof ApiError) {
          showToast(err.message, 'warning')
        } else {
          console.error('Ошибка перехода', err)
          showToast('Не удалось изменить статус: сервер недоступен', 'critical')
        }
        return false
      }
    },
    [scheduleDashboardRefresh, scheduleIncidentChanged, showToast],
  )

  const doAck = useCallback(
    async (id: string) => {
      try {
        const card = await api.ackIncident(id)
        dispatch({ type: 'UPSERT_CARDS', cards: [card] })
        dispatch({ type: 'ACK_CRITICAL', id })
        scheduleDashboardRefresh()
        scheduleIncidentChanged()
      } catch (err) {
        if (err instanceof ApiError) showToast(err.message, 'warning')
        else showToast('Не удалось принять инцидент', 'critical')
      }
    },
    [scheduleDashboardRefresh, scheduleIncidentChanged, showToast],
  )

  const doAssign = useCallback(
    async (card: Card, team: string, executorUserId: string | null) => {
      try {
        let executor: User | undefined
        if (executorUserId !== null) {
          try {
            executor = (await api.fetchUsers()).find(u => u.id === executorUserId)
          } catch (err) {
            console.error('Не удалось загрузить разработчиков', err)
          }
        }
        const patch: { assignedGroupName: string; assignedEmployee?: string; assignedEmployeeLogin?: string } = {
          assignedGroupName: team,
        }
        if (executor !== undefined) {
          const login = executor.itsmLogin ?? ''
          // в данных ITSM исполнитель записан как «ФИО (логин)»; логин связывает карточку с учёткой разработчика
          patch.assignedEmployee = login === '' ? (executor.fullName ?? executor.email) : `${executor.fullName ?? executor.email} (${login})`
          if (login !== '') patch.assignedEmployeeLogin = login
        }
        const detail = await api.patchIncident(card.id, patch)
        dispatch({ type: 'UPSERT_CARDS', cards: [detail] })
        if (executor !== undefined) {
          if ((executor.itsmLogin ?? '') === '') {
            // без логина ITSM разработчику доступ и уведомление даёт только участие в инциденте
            try {
              const memberCard = await api.addMember(card.id, executor.id)
              dispatch({ type: 'UPSERT_CARDS', cards: [memberCard] })
            } catch (err) {
              console.error('Не удалось добавить участника', err)
            }
          }
          showToast(`${team} · ${executor.fullName ?? executor.email} — назначено уведомление`, 'success')
        }
        showToast(`Инцидент ${card.id} назначен команде ${team}`, 'success')
        scheduleDashboardRefresh()
        scheduleIncidentChanged()
        return true
      } catch (err) {
        if (err instanceof ApiError) showToast(err.message, 'warning')
        else showToast('Не удалось назначить команду', 'critical')
        return false
      }
    },
    [scheduleDashboardRefresh, scheduleIncidentChanged, showToast],
  )

  const doFreeze = useCallback(
    async (id: string, body: FreezeRequest) => {
      try {
        const detail = await api.freezeIncident(id, body)
        dispatch({ type: 'UPSERT_CARDS', cards: [detail] })
        scheduleDashboardRefresh()
        scheduleIncidentChanged()
        return true
      } catch (err) {
        if (err instanceof ApiError) showToast(err.message, 'warning')
        else {
          console.error('Ошибка заморозки', err)
          showToast('Не удалось заморозить инцидент: сервер недоступен', 'critical')
        }
        return false
      }
    },
    [scheduleDashboardRefresh, scheduleIncidentChanged, showToast],
  )

  const doUnfreeze = useCallback(
    async (id: string) => {
      try {
        const detail = await api.unfreezeIncident(id)
        dispatch({ type: 'UPSERT_CARDS', cards: [detail] })
        scheduleDashboardRefresh()
        scheduleIncidentChanged()
        return true
      } catch (err) {
        if (err instanceof ApiError) showToast(err.message, 'warning')
        else {
          console.error('Ошибка разморозки', err)
          showToast('Не удалось разморозить инцидент: сервер недоступен', 'critical')
        }
        return false
      }
    },
    [scheduleDashboardRefresh, scheduleIncidentChanged, showToast],
  )

  const doRenameDictItem = useCallback(
    async (field: 'products' | 'assignedGroups', from: string, to: string) => {
      const noun = field === 'products' ? 'Продукт' : 'Команда'
      // команда, созданная администратором, живёт в базе — переименовываем её документ,
      // иначе после перезагрузки вернулось бы старое название
      if (field === 'assignedGroups' && (stateRef.current.dictionaries?.customTeams ?? []).includes(from)) {
        try {
          await api.renameTeam(from, to)
          void refreshDictionaries()
        } catch (err) {
          if (err instanceof ApiError) showToast(err.message, 'warning')
          else {
            console.error('Ошибка переименования команды', err)
            showToast('Не удалось переименовать: сервер недоступен', 'critical')
          }
          return false
        }
      }
      try {
        const res = await api.fetchIncidents(field === 'products' ? { productName: from, perPage: 500 } : { assignedGroupName: from, perPage: 500 })
        let failed = 0
        for (const card of res.items) {
          try {
            const patch = field === 'products' ? { productName: to } : { assignedGroupName: to }
            await api.patchIncident(card.id, patch)
          } catch (err) {
            console.error('Не удалось обновить инцидент при переименовании', err)
            failed += 1
          }
        }
        dispatch({ type: 'RENAME_DICT_ITEM', field, from, to })
        scheduleIncidentChanged()
        scheduleDictionariesRefresh()
        if (field === 'assignedGroups') {
          try {
            const users = await api.fetchUsers()
            for (const u of users) {
              if (u.role === 'developer' && u.deletedAt === null && u.team === from) {
                await api.patchUser(u.id, { team: to })
              }
            }
          } catch (err) {
            console.error('Не удалось перенести участников команды при переименовании', err)
          }
        }
        if (failed === 0) {
          showToast(`${noun} «${from}» переименован в «${to}»`, 'success')
        } else {
          showToast(`${noun} переименован, но ${failed} ${pluralize(failed, 'инцидент', 'инцидента', 'инцидентов')} не обновлено`, 'warning')
        }
        return failed === 0
      } catch (err) {
        console.error('Ошибка переименования', err)
        showToast('Не удалось переименовать: сервер недоступен', 'critical')
        return false
      }
    },
    [showToast, refreshDictionaries, scheduleIncidentChanged, scheduleDictionariesRefresh],
  )

  // звук на новый критический (карточка стала критической и не была)
  const criticalIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (state.user === null) {
      criticalIdsRef.current = new Set()
      return
    }
    const nowCritical = new Set<string>()
    for (const card of state.cards.values()) {
      if (card.isCritical && card.isActive) nowCritical.add(card.id)
    }
    const hadAny = criticalIdsRef.current.size > 0
    for (const id of nowCritical) {
      if (hadAny && !criticalIdsRef.current.has(id)) {
        beepCritical()
        showToast(`Новый критический инцидент: ${id}`, 'critical', id)
        break
      }
    }
    criticalIdsRef.current = nowCritical
  }, [state.cards, state.user, showToast])

  const value = useMemo<AppContextValue>(
    () => ({
      state,
      dispatch,
      login,
      loginWithPair,
      logout,
      register,
      refreshDashboard,
      refreshBoard,
      refreshStats,
      refreshDictionaries,
      doTransition,
      doAck,
      doAssign,
      doFreeze,
      doUnfreeze,
      doRenameDictItem,
      openIncident,
      closeIncident,
      showToast,
    }),
    [state, login, loginWithPair, logout, register, refreshDashboard, refreshBoard, refreshStats, refreshDictionaries, doTransition, doAck, doAssign, doFreeze, doUnfreeze, doRenameDictItem, openIncident, closeIncident, showToast],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

/** Фильтрация карточек по строке поиска и активным фильтрам шапки. */
export function filterCards(
  cards: Card[],
  search: string,
  filters: State['filters'],
): Card[] {
  const query = search.trim().toLowerCase()
  return cards.filter(card => {
    if (filters.priorityId !== null && card.priorityId !== filters.priorityId) return false
    if (filters.product !== null && card.productName !== filters.product) return false
    if (filters.team !== null && card.assignedGroupName !== filters.team) return false
    if (filters.sla !== null && card.sla.state !== filters.sla) return false
    if (filters.status !== null) {
      const match =
        (filters.status === 'unassigned' && isUnassigned(card)) ||
        (filters.status === 'assigned' && card.stateId === ASSIGNED && card.assignedGroupName !== null) ||
        (filters.status === 'progress' && card.stateId === IN_PROGRESS) ||
        (filters.status === 'research' && card.stateId === RESEARCH)
      if (!match) return false
    }
    if (query === '') return true
    return [card.id, card.header, card.productName, card.service, card.assignedEmployee, card.assignedGroupName]
      .some(value => typeof value === 'string' && value.toLowerCase().includes(query))
  })
}
