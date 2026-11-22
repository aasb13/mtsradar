import { useMemo } from 'react'
import { compareCards, isUnassigned, relativeTime, stateLabel } from '../format'
import { navigate } from '../router'
import { useApp } from '../store'
import { SyncBadge, SyncSub } from './shell'
import type { Card } from '../types'
import { Button, EmptyState, Loading, SeverityBadge, SlaChip, TeamIcon } from '../ui'

function InboxCard({ card }: { card: Card }) {
  const { state, dispatch, openIncident } = useApp()
  const routedAt = card.routedTo !== null ? relativeTime(card.routedTo.at, state.now) : null
  return (
    <div className="acard" style={{ borderLeftColor: 'var(--blue)', borderLeftWidth: 4 }} onClick={() => openIncident(card.id)}>
      <div className="acard__top">
        <span className="acard__id">{card.id}</span>
        <SeverityBadge priorityId={card.priorityId} />
      </div>
      <p className="acard__title">{card.header ?? 'Без названия'}</p>
      <p className="acard__line">Продукт: {card.productName ?? '—'}</p>
      <p className="acard__line">
        Статус: <b style={{ color: 'var(--text)' }}>{stateLabel(card)}</b>
        {isUnassigned(card) ? ' · команда не назначена' : ''}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
        <SlaChip card={card} now={state.now} frozen={card.freeze != null} />
        {routedAt !== null && <span style={{ color: 'var(--text-3)', fontSize: 12 }}>поступил вам {routedAt}</span>}
        <span className="spacer" />
        <Button
          variant="primary"
          className="btn--sm"
          onClick={e => {
            e.stopPropagation()
            dispatch({ type: 'OPEN_ASSIGN', id: card.id })
          }}
        >
          <TeamIcon size={15} />
          Передать команде
        </Button>
      </div>
    </div>
  )
}

/** «Ваши инциденты» — личная очередь координатора: посмотреть плашку и передать команде. */
export function InboxPage() {
  const { state } = useApp()
  const staffId = state.user?.id

  const inbox = useMemo(() => {
    const pending: Card[] = []
    let doneToday = 0
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    for (const card of state.cards.values()) {
      // поле отсутствует у сервера старой версии — считаем, что инцидент не распределён
      const route = card.routedTo ?? null
      if (route === null || route.userId !== staffId) continue
      if (route.doneAt !== null && route.doneAt !== undefined) {
        const t = Date.parse(route.doneAt)
        if (!Number.isNaN(t) && t >= dayStart.getTime()) doneToday += 1
        continue
      }
      if (!card.isActive || card.isResolved) continue
      pending.push(card)
    }
    pending.sort((a, b) => compareCards(a, b))
    return { pending, criticals: pending.filter(c => c.isCritical).length, doneToday }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.cards, staffId, state.now])

  if (staffId === undefined || state.dictionaries === null) {
    return <Loading style={{ padding: 24 }} />
  }

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Ваши инциденты</h1>
          <p className="pagehead__sub">
            Новые инциденты приходят вам — посмотрите и передайте команде
            <SyncSub syncedAt={state.syncedAt} now={state.now} />
          </p>
        </div>
        <div className="pagehead__actions">
          <SyncBadge />
        </div>
      </div>

      <div className="kpis">
        <div className="kpi">
          <p className="kpi__label">Поступило вам</p>
          <p className="kpi__value" key={inbox.pending.length}>{inbox.pending.length}</p>
          <p className="kpi__sub">ждут команды</p>
        </div>
        <div className="kpi">
          <p className="kpi__label">Критических</p>
          <p className="kpi__value kpi__value--red" key={inbox.criticals}>{inbox.criticals}</p>
          <p className="kpi__sub">{inbox.pending.length > 0 ? 'разберите первыми' : '—'}</p>
        </div>
        <div className="kpi">
          <p className="kpi__label">Распределено сегодня</p>
          <p className="kpi__value" key={inbox.doneToday}>{inbox.doneToday}</p>
          <p className="kpi__sub">передано командам за смену</p>
        </div>
      </div>

      <div className="toolrow">
        <div className="tabs">
          <button type="button" className="tabs__tab tabs__tab--active">Ваши инциденты</button>
          <button type="button" className="tabs__tab" onClick={() => navigate('/kanban')}>
            Канбан
          </button>
          <button type="button" className="tabs__tab" onClick={() => navigate('/attention')}>
            Группы внимания
          </button>
        </div>
      </div>

      {inbox.pending.length === 0 ? (
        <EmptyState
          title="Всё распределено"
          note="Новые инциденты появятся здесь сами — осталось передать их команде"
        />
      ) : (
        <div>
          {inbox.pending.map(card => (
            <InboxCard key={card.id} card={card} />
          ))}
        </div>
      )}
    </>
  )
}
