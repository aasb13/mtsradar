import { useEffect, useRef, useState } from 'react'
import { useDashboard } from '../store'
import { relativeTime } from '../format'
import type { ChangeKind } from '../types'
import { IconBell, IconMoon, IconSearch, IconSun } from './Icons'

const FEED_DOT: Record<ChangeKind, string> = {
  critical_new: 'red',
  resolved: 'green',
  reopened: 'blue',
  research_new: 'orange',
  deadline_changed: 'orange',
  priority_changed: 'purple',
  coordinator_assigned: 'blue',
  created: 'grey',
  updated: 'grey',
}

export function Header() {
  const { state, dispatch, searchRef } = useDashboard()
  const [feedOpen, setFeedOpen] = useState(false)
  const bellRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!feedOpen) return
    const onPointerDown = (e: MouseEvent) => {
      if (bellRef.current !== null && !bellRef.current.contains(e.target as Node)) setFeedOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [feedOpen])

  const focusSearch = () => {
    searchRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    searchRef.current?.focus()
  }

  const connectionText =
    state.connection === 'online' ? 'Онлайн' : state.connection === 'connecting' ? 'Подключение…' : 'Переподключение…'

  return (
    <header className="header">
      <div className="header__logo">МТС</div>
      <h1 className="header__title">Дашборд координатора IT-инцидентов</h1>
      <span className={`conn conn--${state.connection}`}>
        <span className="conn__dot" />
        {connectionText}
      </span>
      <div className="header__spacer" />
      <button type="button" className="icon-btn header__search-btn" onClick={focusSearch} title="Поиск (Ctrl+K)">
        <IconSearch size={16} />
        <span className="header__kbd">Ctrl+K</span>
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={() => dispatch({ type: 'SET_THEME', theme: state.theme === 'light' ? 'dark' : 'light' })}
        title={state.theme === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему'}
      >
        {state.theme === 'light' ? <IconMoon size={16} /> : <IconSun size={16} />}
      </button>
      <div className="header__bell" ref={bellRef}>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setFeedOpen(open => !open)}
          title="События смены"
        >
          <IconBell size={17} />
          {state.unread > 0 && <span className="badge-unread">{state.unread > 99 ? '99+' : state.unread}</span>}
        </button>
        {feedOpen && (
          <div className="feed">
            <div className="feed__head">
              <span className="feed__title">События смены</span>
              <button type="button" className="link-btn" onClick={() => dispatch({ type: 'MARK_FEED_READ' })}>
                Прочитать всё
              </button>
            </div>
            <div className="feed__list">
              {state.feed.length === 0 ? (
                <div className="feed__empty">Событий пока нет — изменения инцидентов появятся здесь</div>
              ) : (
                state.feed.map(item => (
                  <div key={item.key} className="feed__item">
                    <span className={`feed__dot feed__dot--${FEED_DOT[item.kind]}`} />
                    <span className="feed__text">{item.text}</span>
                    <span className="feed__time">{relativeTime(item.ts, state.now)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </header>
  )
}
