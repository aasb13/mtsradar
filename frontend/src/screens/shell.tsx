import { useEffect, useRef, useState } from 'react'
import { initials, pluralize, relativeTime } from '../format'
import { navigate, useRoute } from '../router'
import { useApp } from '../store'
import { BellIcon, CloseIcon, LogoutIcon, MoonIcon, SearchIcon, StatsIcon, SunIcon } from '../ui'
import * as api from '../api'
import type { Notification, Role } from '../types'

interface NavItem {
  path: string
  label: string
}

const NAV: Record<Role, NavItem[]> = {
  coordinator: [
    { path: '/', label: 'Канбан' },
    { path: '/attention', label: 'Группы внимания' },
  ],
  admin: [
    { path: '/', label: 'Канбан' },
    { path: '/attention', label: 'Группы внимания' },
    { path: '/admin', label: 'Инциденты' },
    { path: '/admin/products', label: 'Продукты' },
    { path: '/admin/teams', label: 'Команды' },
    { path: '/admin/users', label: 'Пользователи' },
    { path: '/admin/done', label: 'Завершённые' },
  ],
  developer: [],
  viewer: [],
}

function Logo() {
  return (
    <a
      className="logo"
      href="#/"
      onClick={e => {
        e.preventDefault()
        navigate('/')
      }}
    >
      <span className="logo__box">
        <span className="logo__mts">МТС</span>
        <span className="logo__radar">РАДАР</span>
      </span>
    </a>
  )
}

function SearchBox() {
  const { state, dispatch } = useApp()
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
        e.preventDefault()
        setOpen(true)
        window.setTimeout(() => inputRef.current?.focus(), 0)
      }
      if (e.key === 'Escape' && open) {
        setOpen(false)
        dispatch({ type: 'SET_SEARCH', search: '' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, dispatch])

  if (open) {
    return (
      <input
        ref={inputRef}
        className="input"
        style={{ width: 280, height: 40 }}
        value={state.search}
        placeholder="Поиск по номеру, названию, продукту…"
        onChange={e => dispatch({ type: 'SET_SEARCH', search: e.target.value })}
        onBlur={() => {
          if (state.search === '') setOpen(false)
        }}
      />
    )
  }
  return (
    <button
      type="button"
      className="headerbtn"
      onClick={() => {
        setOpen(true)
        window.setTimeout(() => inputRef.current?.focus(), 0)
      }}
    >
      <SearchIcon size={16} />
      Поиск
    </button>
  )
}

function BellMenu({ onClose }: { onClose: () => void }) {
  const { state, dispatch, showToast } = useApp()
  const [items, setItems] = useState<Notification[]>(state.notifications)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.fetchNotifications()
        setItems(res.items)
        dispatch({ type: 'SET_NOTIFICATIONS', items: res.items, unread: res.unread })
      } catch (err) {
        console.error('Не удалось загрузить уведомления', err)
      } finally {
        setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const open = async (notification: Notification) => {
    try {
      if (notification.readAt === null) {
        await api.markNotificationRead(notification.id)
        const res = await api.fetchNotifications()
        dispatch({ type: 'SET_NOTIFICATIONS', items: res.items, unread: res.unread })
      }
    } catch (err) {
      console.error('Не удалось отметить уведомление', err)
    }
    if (notification.incidentId !== null && notification.incidentId !== undefined) {
      onClose()
      dispatch({ type: 'OPEN_PANEL', id: notification.incidentId })
      return
    }
    onClose()
    if (notification.body !== null && notification.body !== '') showToast(notification.body, 'info')
  }

  return (
    <div className="bell-menu">
      <div className="bell-menu__head">
        Уведомления
        <button
          type="button"
          onClick={() => {
            void (async () => {
              try {
                await api.markAllNotificationsRead()
                const res = await api.fetchNotifications()
                dispatch({ type: 'SET_NOTIFICATIONS', items: res.items, unread: res.unread })
              } catch (err) {
                console.error('Не удалось отметить все уведомления', err)
              }
            })()
          }}
        >
          Прочитать все
        </button>
      </div>
      {loading ? (
        <div className="bell-menu__empty">Загрузка…</div>
      ) : items.length === 0 ? (
        <div className="bell-menu__empty">Уведомлений нет — всё спокойно</div>
      ) : (
        items.map(n => (
          <div key={n.id} className={`notif ${n.readAt === null ? 'notif--unread' : ''}`} onClick={() => void open(n)}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p className="notif__title">{n.title ?? 'Событие'}</p>
              {n.body !== null && <p className="notif__body">{n.body}</p>}
            </div>
            <span className="notif__time">{relativeTime(n.createdAt, state.now)}</span>
          </div>
        ))
      )}
    </div>
  )
}

function AvatarMenu({ onClose }: { onClose: () => void }) {
  const { state, logout, dispatch } = useApp()
  const user = state.user
  if (user === null) return null
  return (
    <div className="bell-menu" style={{ width: 300 }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-soft)' }}>
        <p style={{ fontWeight: 700 }}>{user.fullName ?? user.email}</p>
        <p style={{ fontSize: 13, color: 'var(--text-2)' }}>{user.email}</p>
        <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>Роль: {ROLE_LABEL[user.role] ?? user.role}</p>
      </div>
      <div style={{ padding: 8 }}>
        <button
          type="button"
          className="fchip-menu__sel"
          style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8 }}
          onClick={() => {
            dispatch({ type: 'SET_THEME', theme: state.theme === 'dark' ? 'light' : 'dark' })
            onClose()
          }}
        >
          {state.theme === 'dark' ? (<><SunIcon size={16} /> Светлая тема</>) : (<><MoonIcon size={16} /> Тёмная тема</>)}
        </button>
        <button
          type="button"
          style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, color: 'var(--red)' }}
          onClick={() => {
            onClose()
            void logout()
          }}
        >
          <LogoutIcon size={16} />
          Выйти
        </button>
      </div>
    </div>
  )
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Администратор',
  coordinator: 'Координатор',
  developer: 'Разработчик',
  viewer: 'Тестировщик',
}

export function Header() {
  const { state } = useApp()
  const route = useRoute()
  const user = state.user
  const [menu, setMenu] = useState<'bell' | 'avatar' | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  if (user === null) return null
  const items = NAV[user.role] ?? []
  const showStats = user.role === 'coordinator' || user.role === 'admin'

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) setMenu(null)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [])

  return (
    <header className="header">
      <Logo />
      <nav className="nav">
        {items.map(item => (
          <a
            key={item.path}
            className={`nav__link ${route === item.path || (item.path === '/admin' && route.startsWith('/admin') && !item.path.includes('/')) ? 'nav__link--active' : ''}`}
            href={`#${item.path}`}
            onClick={e => {
              e.preventDefault()
              navigate(item.path)
            }}
          >
            {item.label}
          </a>
        ))}
      </nav>
      <div className="header__right" ref={wrapRef}>
        <SearchBox />
        <div className="bell">
          <button
            type="button"
            className="headerbtn bell"
            style={{ padding: '0 12px', width: 48, justifyContent: 'center' }}
            aria-label="Уведомления"
            onClick={() => setMenu(menu === 'bell' ? null : 'bell')}
          >
            <BellIcon size={17} />
            {state.unread > 0 && <span className="bell__dot" />}
          </button>
          {menu === 'bell' && <BellMenu onClose={() => setMenu(null)} />}
        </div>
        {showStats && (
          <button
            type="button"
            className={`headerbtn ${route === '/stats' ? 'headerbtn--primary' : 'headerbtn--outline'}`}
            onClick={() => navigate('/stats')}
          >
            <StatsIcon size={16} />
            Статистика
          </button>
        )}
        <div style={{ position: 'relative' }}>
          <span
            className="avatar avatar--md avatar--user"
            style={{ cursor: 'pointer' }}
            onClick={() => setMenu(menu === 'avatar' ? null : 'avatar')}
            title={user.fullName ?? user.email}
          >
            {initials(user.fullName ?? user.email)}
          </span>
          {menu === 'avatar' && <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0 }}><AvatarMenu onClose={() => setMenu(null)} /></div>}
        </div>
      </div>
    </header>
  )
}

export function ToastStack() {
  const { state, dispatch } = useApp()
  useEffect(() => {
    if (state.toasts.length === 0) return
    const timers = state.toasts
      .filter(t => t.tone !== 'critical')
      .map(t => window.setTimeout(() => dispatch({ type: 'DISMISS_TOAST', key: t.key }), 6000))
    return () => {
      for (const id of timers) window.clearTimeout(id)
    }
  }, [state.toasts, dispatch])
  return (
    <div className="toasts">
      {state.toasts.map(t => (
        <div key={t.key} className={`toast toast--${t.tone}`}>
          <span className={`toast__icon toast__icon--${t.tone}`}>
            {t.tone === 'success' ? <CheckCircleGlyph /> : <InfoGlyph />}
          </span>
          <span className="toast__text">{t.text}</span>
          <button type="button" className="toast__close" onClick={() => dispatch({ type: 'DISMISS_TOAST', key: t.key })} aria-label="Скрыть">
            <CloseIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

function InfoGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v.1M12 11v5" />
    </svg>
  )
}

function CheckCircleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </svg>
  )
}

export function SyncBadge() {
  const { state } = useApp()
  const label =
    state.connection === 'online'
      ? `Онлайн · ${state.coordinatorCount} ${pluralize(state.coordinatorCount, 'координатор', 'координатора', 'координаторов')}`
      : state.connection === 'connecting'
        ? 'Подключение…'
        : 'Переподключение…'
  return (
    <span className="onlinebadge" style={state.connection !== 'online' ? { background: 'rgba(245,197,24,0.25)', color: '#b7791f' } : undefined}>
      <span className="onlinebadge__dot" style={state.connection !== 'online' ? { background: 'var(--yellow)' } : undefined} />
      {label}
    </span>
  )
}

export function SyncSub({ syncedAt, now }: { syncedAt: number | null; now: number }) {
  if (syncedAt === null) return null
  return <> · обновлено {relativeTime(new Date(syncedAt).toISOString(), now)}</>
}
