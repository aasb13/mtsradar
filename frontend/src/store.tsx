import { createContext, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import type { Dispatch, ReactNode, RefObject } from 'react'
import type { ChangeKind, Incident, Summary, ToastType, WsChange, WsMessage } from './types'
import { fetchIncidents, fetchSummary } from './api'
import { connectDashboardSocket } from './ws'
import { beepCritical } from './beep'
import { FEED_TEXT, KIND_PRIORITY, TOAST_META, liveSla } from './format'

export type FilterKey = 'all' | 'critical' | 'coordinators' | 'high_priority' | 'research' | 'breached'
export type ConnectionState = 'connecting' | 'online' | 'reconnecting'
export type Theme = 'light' | 'dark'

export interface FeedItem {
  key: string
  incidentId: string
  kind: ChangeKind
  text: string
  ts: number
}

export interface ToastItem {
  key: string
  kind: ChangeKind | 'boot_error'
  type: ToastType
  text: string
  sticky: boolean
  createdAt: number
}

interface State {
  incidents: Incident[]
  summary: Summary | null
  generatedAt: string | null
  syncedAt: number | null
  liveSynced: boolean
  connection: ConnectionState
  bootError: string | null
  reloadNonce: number
  feed: FeedItem[]
  unread: number
  toasts: ToastItem[]
  ribbonDismissed: boolean
  drawerId: string | null
  filter: FilterKey
  search: string
  theme: Theme
  shortcutsOpen: boolean
  now: number
}

const THEME_KEY = 'mts-dashboard-theme'
const FEED_LIMIT = 50
const TOAST_LIMIT = 5

function makeInitialState(): State {
  let theme: Theme = 'light'
  try {
    if (window.localStorage.getItem(THEME_KEY) === 'dark') theme = 'dark'
  } catch (err) {
    console.error('Не удалось прочитать тему из localStorage', err)
  }
  return {
    incidents: [],
    summary: null,
    generatedAt: null,
    syncedAt: null,
    liveSynced: false,
    connection: 'connecting',
    bootError: null,
    reloadNonce: 0,
    feed: [],
    unread: 0,
    toasts: [],
    ribbonDismissed: false,
    drawerId: null,
    filter: 'all',
    search: '',
    theme,
    shortcutsOpen: false,
    now: Date.now(),
  }
}

export type Action =
  | { type: 'BOOT_OK'; incidents: Incident[]; summary: Summary }
  | { type: 'BOOT_FAIL'; message: string; toast: ToastItem }
  | { type: 'SNAPSHOT'; incidents: Incident[]; summary: Summary }
  | { type: 'UPDATE'; incidents: Incident[]; summary: Summary; feed: FeedItem[]; toasts: ToastItem[] }
  | { type: 'CONN'; state: ConnectionState }
  | { type: 'RELOAD' }
  | { type: 'TICK'; now: number }
  | { type: 'DISMISS_TOAST'; key: string }
  | { type: 'MARK_FEED_READ' }
  | { type: 'DISMISS_RIBBON' }
  | { type: 'OPEN_DRAWER'; id: string }
  | { type: 'CLOSE_DRAWER' }
  | { type: 'SET_FILTER'; filter: FilterKey }
  | { type: 'SET_SEARCH'; search: string }
  | { type: 'SET_THEME'; theme: Theme }
  | { type: 'TOGGLE_SHORTCUTS' }

function capToasts(list: ToastItem[]): ToastItem[] {
  const result = [...list]
  while (result.length > TOAST_LIMIT) {
    const idx = result.findIndex(t => !t.sticky)
    result.splice(idx === -1 ? 0 : idx, 1)
  }
  return result
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'BOOT_OK': {
      if (state.liveSynced) return state
      return {
        ...state,
        incidents: action.incidents,
        summary: action.summary,
        generatedAt: action.summary.generatedAt,
        syncedAt: Date.now(),
        bootError: null,
      }
    }
    case 'BOOT_FAIL': {
      const toasts = state.toasts.filter(t => t.kind !== 'boot_error')
      return { ...state, bootError: action.message, toasts: capToasts([...toasts, action.toast]) }
    }
    case 'SNAPSHOT':
      return {
        ...state,
        incidents: action.incidents,
        summary: action.summary,
        generatedAt: action.summary.generatedAt,
        syncedAt: Date.now(),
        liveSynced: true,
        bootError: null,
      }
    case 'UPDATE': {
      const existingKeys = new Set(state.toasts.map(t => t.key))
      const mergedToasts = [...state.toasts]
      for (const toast of action.toasts) {
        if (!existingKeys.has(toast.key)) {
          existingKeys.add(toast.key)
          mergedToasts.push(toast)
        }
      }
      return {
        ...state,
        incidents: action.incidents,
        summary: action.summary,
        generatedAt: action.summary.generatedAt,
        syncedAt: Date.now(),
        liveSynced: true,
        bootError: null,
        feed: [...action.feed, ...state.feed].slice(0, FEED_LIMIT),
        unread: state.unread + action.feed.length,
        toasts: capToasts(mergedToasts),
        ribbonDismissed: action.toasts.some(t => t.kind === 'critical_new') ? false : state.ribbonDismissed,
      }
    }
    case 'CONN':
      return { ...state, connection: action.state }
    case 'RELOAD':
      return { ...state, reloadNonce: state.reloadNonce + 1 }
    case 'TICK':
      return { ...state, now: action.now }
    case 'DISMISS_TOAST':
      return { ...state, toasts: state.toasts.filter(t => t.key !== action.key) }
    case 'MARK_FEED_READ':
      return { ...state, unread: 0 }
    case 'DISMISS_RIBBON':
      return { ...state, ribbonDismissed: true }
    case 'OPEN_DRAWER':
      return { ...state, drawerId: action.id }
    case 'CLOSE_DRAWER':
      return { ...state, drawerId: null }
    case 'SET_FILTER':
      return { ...state, filter: action.filter }
    case 'SET_SEARCH':
      return { ...state, search: action.search }
    case 'SET_THEME':
      return { ...state, theme: action.theme }
    case 'TOGGLE_SHORTCUTS':
      return { ...state, shortcutsOpen: !state.shortcutsOpen }
    default: {
      const never: never = action
      void never
      return state
    }
  }
}

/**
 * Пачка изменений из одного update-сообщения → лента в «колокольчике»
 * (по одному событию на уникальную пару id+kind) и тосты (по одному
 * на инцидент — самый значимый kind; повторы гасятся по ключу).
 */
function buildChangeItems(changes: WsChange[], ts: number): { feed: FeedItem[]; toasts: ToastItem[] } {
  const seenPairs = new Set<string>()
  const feed: FeedItem[] = []
  for (const change of changes) {
    const pairKey = `${change.id}|${change.kind}`
    if (seenPairs.has(pairKey)) continue
    seenPairs.add(pairKey)
    feed.push({
      key: `${ts}|${pairKey}`,
      incidentId: change.id,
      kind: change.kind,
      text: `${change.id} — ${FEED_TEXT[change.kind]}`,
      ts,
    })
  }
  const topKind = new Map<string, ChangeKind>()
  for (const change of changes) {
    const current = topKind.get(change.id)
    if (current === undefined || KIND_PRIORITY.indexOf(change.kind) < KIND_PRIORITY.indexOf(current)) {
      topKind.set(change.id, change.kind)
    }
  }
  const toasts: ToastItem[] = []
  for (const [id, kind] of topKind) {
    const meta = TOAST_META[kind]
    toasts.push({
      key: `${id}|${kind}`,
      kind,
      type: meta.type,
      text: meta.text(id),
      sticky: kind === 'critical_new',
      createdAt: ts,
    })
  }
  return { feed, toasts }
}

export function matchFilter(incident: Incident, filter: FilterKey, syncedAt: number | null, now: number): boolean {
  if (filter === 'all') return true
  if (filter === 'breached') return liveSla(incident, syncedAt, now).breached
  return incident.groups.includes(filter)
}

interface DashboardContextValue {
  state: State
  dispatch: Dispatch<Action>
  searchRef: RefObject<HTMLInputElement | null>
}

const DashboardContext = createContext<DashboardContextValue | null>(null)

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext)
  if (ctx === null) throw new Error('useDashboard должен вызываться внутри DashboardProvider')
  return ctx
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, null, makeInitialState)
  const searchRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => dispatch({ type: 'TICK', now: Date.now() }), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = state.theme
    try {
      window.localStorage.setItem(THEME_KEY, state.theme)
    } catch (err) {
      console.error('Не удалось сохранить тему в localStorage', err)
    }
  }, [state.theme])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [incidentsRes, summary] = await Promise.all([fetchIncidents(), fetchSummary()])
        if (!cancelled) dispatch({ type: 'BOOT_OK', incidents: incidentsRes.incidents, summary })
      } catch (err) {
        console.error('Не удалось загрузить данные дашборда', err)
        if (!cancelled) {
          dispatch({
            type: 'BOOT_FAIL',
            message: 'Сервер недоступен. Данные дашборда не загружены.',
            toast: {
              key: 'boot_error',
              kind: 'boot_error',
              type: 'critical',
              text: 'Не удалось загрузить данные дашборда',
              sticky: false,
              createdAt: Date.now(),
            },
          })
        }
      }
    })()
    const disposeSocket = connectDashboardSocket({
      onState: connection => dispatch({ type: 'CONN', state: connection }),
      onMessage: (message: WsMessage) => {
        const receivedAt = Date.now()
        if (message.type === 'snapshot') {
          dispatch({ type: 'SNAPSHOT', incidents: message.payload.incidents, summary: message.payload.summary })
          return
        }
        const { feed, toasts } = buildChangeItems(message.payload.changes, receivedAt)
        if (message.payload.changes.some(c => c.kind === 'critical_new')) beepCritical()
        dispatch({ type: 'UPDATE', incidents: message.payload.incidents, summary: message.payload.summary, feed, toasts })
      },
    })
    return () => {
      cancelled = true
      disposeSocket()
    }
  }, [state.reloadNonce])

  const value = useMemo<DashboardContextValue>(() => ({ state, dispatch, searchRef }), [state])

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>
}
