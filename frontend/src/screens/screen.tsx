import { useEffect, useMemo, useRef, useState } from 'react'
import { compareCards, formatTimeLeft, pluralize, relativeTime, todayWeekday } from '../format'
import { useApp } from '../store'
import type { Card, Comment, ToastItem } from '../types'
import { ClockIcon, SnowflakeIcon, TeamIcon } from '../ui'

interface FeedEntry {
  id: string
  at: number
  text: string
  tone: ToastItem['tone']
  incidentId?: string
}

/** Остаток SLA с учётом локального тика и серверной заморозки. Отрицательное — просрочка. */
function secondsLeft(card: Card, now: number): number | null {
  if (card.sla.timeLeftSeconds === null) return null
  const anchor = card.updatedAt === null ? Number.NaN : Date.parse(card.updatedAt)
  const elapsed = card.freeze != null || Number.isNaN(anchor) ? 0 : Math.max(0, (now - anchor) / 1000)
  if (card.sla.state === 'breached') return -((card.sla.overdueSeconds ?? 0) + elapsed)
  return card.sla.timeLeftSeconds - elapsed
}

const FEED_LIMIT = 14

export function ScreenPage() {
  const { state, openIncident } = useApp()

  const hero = useMemo(() => {
    let best: { card: Card; left: number } | null = null
    for (const card of state.cards.values()) {
      if (!card.isActive || card.isResolved || card.freeze != null) continue
      if (card.sla.state === 'none' || card.sla.state === 'resolved') continue
      const left = secondsLeft(card, state.now)
      if (left === null) continue
      const better =
        best === null ||
        (left >= 0 && (best.left < 0 || left < best.left)) ||
        (left < 0 && best.left < 0 && left > best.left)
      if (better) best = { card, left }
    }
    return best
  }, [state.cards, state.now])

  const criticals = useMemo(
    () =>
      [...state.cards.values()]
        .filter(card => card.isCritical && card.isActive && !card.isResolved)
        .sort(compareCards)
        .slice(0, 4),
    [state.cards],
  )

  const [feed, setFeed] = useState<FeedEntry[]>([])
  const seenToasts = useRef<Set<string> | null>(null)

  useEffect(() => {
    const seen = seenToasts.current
    if (seen === null) {
      seenToasts.current = new Set(state.toasts.map(t => t.key))
      return
    }
    const fresh = state.toasts.filter(t => !seen.has(t.key))
    if (fresh.length === 0) return
    for (const t of fresh) seen.add(t.key)
    setFeed(prev => [
      ...fresh.map(t => ({ id: `toast:${t.key}`, at: t.createdAt, text: t.text, tone: t.tone, incidentId: t.incidentId })),
      ...prev,
    ].slice(0, FEED_LIMIT))
  }, [state.toasts])

  useEffect(() => {
    const items = state.notifications.slice(-6).map(n => ({
      id: `notif:${n.id}`,
      at: Date.parse(n.createdAt),
      text: n.body ?? n.title ?? 'Событие',
      tone: 'info' as const,
      incidentId: n.incidentId ?? undefined,
    }))
    setFeed(prev => {
      const known = new Set(prev.map(entry => entry.id))
      const added = items.filter(entry => !known.has(entry.id) && !Number.isNaN(entry.at))
      return added.length === 0 ? prev : [...added.reverse(), ...prev].slice(0, FEED_LIMIT)
    })
  }, [state.notifications])

  useEffect(() => {
    const onComment = (e: Event) => {
      const comment = (e as CustomEvent<Comment>).detail
      setFeed(prev => [
        { id: `comment:${comment.id}`, at: Date.now(), text: `Новый комментарий · ${comment.incidentId}`, tone: 'info' as const, incidentId: comment.incidentId },
        ...prev,
      ].slice(0, FEED_LIMIT))
    }
    window.addEventListener('radar:comment', onComment)
    return () => window.removeEventListener('radar:comment', onComment)
  }, [])

  const clock = new Date(state.now).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const heroBudget = hero?.card.sla.totalSeconds ?? null
  const heroPct = hero !== null && heroBudget !== null && heroBudget > 0
    ? Math.min(100, Math.max(0, ((heroBudget - hero.left) / heroBudget) * 100))
    : null
  const kpi = state.kpi

  const open = (id?: string) => {
    if (id !== undefined) openIncident(id)
  }

  return (
    <div className="screen">
      <header className="screen__head">
        <div className="screen__brand">
          <span className="screen__logo"><span>МТС</span><span>РАДАР</span></span>
          <span className="screen__title">Штаб управления инцидентами</span>
        </div>
        <div className="screen__headright">
          <span className={`screen__conn ${state.connection === 'online' ? '' : 'screen__conn--off'}`}>
            <span className="screen__dot" />
            {state.connection === 'online' ? 'Онлайн' : state.connection === 'connecting' ? 'Подключение' : 'Переподключение'}
          </span>
          <span className="screen__date">{todayWeekday(state.now)}</span>
          <span className="screen__clock">{clock}</span>
        </div>
      </header>

      <section className={`screen__hero ${hero !== null && hero.left < 0 ? 'screen__hero--breach' : ''}`}>
        <div className="screen__hero-main">
          <p className="screen__hero-label">{hero !== null && hero.left < 0 ? 'Просрочено на' : 'Ближайший прорыв SLA'}</p>
          <p className="screen__hero-time">{hero === null ? '—' : formatTimeLeft(Math.abs(hero.left))}</p>
          <p className="screen__hero-sub">
            {hero === null
              ? 'Активных инцидентов со сроком нет'
              : `${hero.card.id} · ${hero.card.header ?? 'без названия'} · ${hero.card.productName ?? 'продукт не указан'}`}
          </p>
        </div>
        <div className="screen__hero-side">
          {hero !== null && hero.card.freeze == null && heroPct !== null && (
            <>
              <p className="screen__hero-meta">SLA-бюджет израсходован</p>
              <p className="screen__hero-pct">{Math.round(heroPct)}%</p>
              <div className="screen__track"><span style={{ width: `${heroPct}%` }} /></div>
            </>
          )}
          <div className="screen__hero-tags">
            {hero !== null && (
              <>
                <span><TeamIcon size={15} /> {hero.card.assignedGroupName ?? 'команда не назначена'}</span>
                <span><ClockIcon size={15} /> дедлайн {hero.card.deadline === null ? '—' : new Date(hero.card.deadline).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              </>
            )}
          </div>
        </div>
      </section>

      <div className="screen__body">
        <section className="screen__panel">
          <div className="screen__panel-head">
            <h2>Критические инциденты</h2>
            <span className="screen__count">{criticals.length}</span>
          </div>
          <div className="screen__rows">
            {criticals.length === 0 && <p className="screen__empty">Критических инцидентов нет</p>}
            {criticals.map(card => (
              <div key={card.id} className="screen__row screen__row--critical" onClick={() => open(card.id)}>
                <span className="screen__row-id">{card.id}</span>
                <span className="screen__row-main">
                  <b>{card.header ?? 'Без названия'}</b>
                  <small>{card.productName ?? '—'} · {card.service ?? '—'} · {card.assignedGroupName ?? 'команда не назначена'}</small>
                </span>
                {card.freeze != null && <span className="screen__frozen" title={card.freeze.reason}><SnowflakeIcon size={14} /> пауза</span>}
                <span className="screen__row-time">{formatTimeLeft(Math.abs(secondsLeft(card, state.now) ?? 0))}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="screen__panel screen__panel--feed">
          <div className="screen__panel-head">
            <h2>Живая лента</h2>
            <span className="screen__live">LIVE</span>
          </div>
          <div className="screen__rows">
            {feed.length === 0 && <p className="screen__empty">Ожидаем события — появятся новые инциденты, назначения и решения</p>}
            {feed.map(entry => (
              <div key={entry.id} className="screen__row screen__row--feed" onClick={() => open(entry.incidentId)}>
                <span className={`screen__feed-dot screen__feed-dot--${entry.tone}`} />
                <span className="screen__row-main">
                  <b>{entry.text}</b>
                  <small>{relativeTime(new Date(entry.at).toISOString(), state.now)}</small>
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <footer className="screen__kpis">
        <div><p>Открыто</p><b>{kpi?.active ?? '—'}</b></div>
        <div><p>Критических</p><b className="screen__kpi-red">{kpi?.critical ?? '—'}</b></div>
        <div><p>Просрочено</p><b className="screen__kpi-red">{kpi?.breached ?? '—'}</b></div>
        <div>
          <p>На связи</p>
          <b>{state.coordinatorCount} {pluralize(state.coordinatorCount, 'координатор', 'координатора', 'координаторов')}</b>
        </div>
      </footer>
    </div>
  )
}
