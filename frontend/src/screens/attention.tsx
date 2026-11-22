import { useMemo } from 'react'
import { compareCards, todayWeekday } from '../format'
import { navigate } from '../router'
import { filterCards, useApp } from '../store'
import { CriticalBanner, FilterChipMenu, KpiRow, SLA_LABELS } from './kanban'
import { SyncBadge, SyncSub } from './shell'
import type { Card } from '../types'
import { SeverityBadge } from '../ui'

const LEVEL_BG: Record<number, string> = {
  4: 'var(--red)',
  3: '#e8556a',
  2: '#ea7c88',
  1: '#eda3a9',
}

function LevelCard({ card }: { card: Card }) {
  const { dispatch } = useApp()
  return (
    <div
      className="acard"
      style={{
        borderLeftColor:
          card.isCritical || card.priorityId === 4
            ? 'var(--red)'
            : card.priorityId === 3
              ? 'var(--orange)'
              : card.priorityId === 2
                ? 'var(--yellow)'
                : 'var(--gray)',
      }}
      onClick={() => dispatch({ type: 'OPEN_PANEL', id: card.id })}
    >
      <div className="acard__top">
        <span className="acard__id">#{card.id}</span>
        <SeverityBadge priorityId={card.priorityId} />
      </div>
      <p className="acard__title">{card.header ?? 'Без названия'}</p>
      <p className="acard__line">Продукт: {card.productName ?? '—'}</p>
      <p className="acard__line">
        Статус: <b style={{ color: 'var(--text)' }}>{card.state ?? card.stateId}</b>
      </p>
    </div>
  )
}

/** Колонки «Групп внимания» = уровни приоритета по кейсу (4 → 1). */
export function AttentionPage() {
  const { state, dispatch } = useApp()

  const cards = useMemo(
    () => filterCards([...state.cards.values()], state.search, state.filters),
    [state.cards, state.search, state.filters],
  )

  const levels = useMemo(() => {
    const byLevel: Record<number, Card[]> = { 4: [], 3: [], 2: [], 1: [] }
    for (const card of cards) {
      if (!card.isActive) continue
      ;(byLevel[card.priorityId] ??= []).push(card)
    }
    for (const list of Object.values(byLevel)) list.sort((a, b) => compareCards(a, b))
    return [4, 3, 2, 1].map(priorityId => ({
      priorityId,
      title: `${priorityId} уровень`,
      count: byLevel[priorityId]?.length ?? 0,
      items: byLevel[priorityId] ?? [],
    }))
  }, [cards, state.now])

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Инциденты смены</h1>
          <p className="pagehead__sub">
            {todayWeekday(state.now)}
            <SyncSub syncedAt={state.syncedAt} now={state.now} />
          </p>
        </div>
        <div className="pagehead__actions">
          <SyncBadge />
        </div>
      </div>

      <KpiRow />
      <CriticalBanner />

      <div className="toolrow">
        <div className="tabs">
          <button type="button" className="tabs__tab" onClick={() => navigate('/')}>
            Канбан
          </button>
          <button type="button" className="tabs__tab tabs__tab--active">
            Группы внимания
          </button>
        </div>
        <div className="fchips">
          <FilterChipMenu
            label="Уровень"
            value={state.filters.priorityId === null ? 'Все' : `${state.filters.priorityId} уровень`}
            options={[
              { key: null, label: 'Все' },
              { key: 4, label: '4 уровень' },
              { key: 3, label: '3 уровень' },
              { key: 2, label: '2 уровень' },
              { key: 1, label: '1 уровень' },
            ]}
            onSelect={key => dispatch({ type: 'SET_FILTERS', patch: { priorityId: key as number | null } })}
          />
          <FilterChipMenu
            label="SLA"
            value={state.filters.sla === null ? 'Все' : SLA_LABELS[state.filters.sla] ?? state.filters.sla}
            options={[
              { key: null, label: 'Все' },
              { key: 'ok', label: SLA_LABELS.ok },
              { key: 'warning', label: SLA_LABELS.warning },
              { key: 'danger', label: SLA_LABELS.danger },
              { key: 'breached', label: SLA_LABELS.breached },
            ]}
            onSelect={key => dispatch({ type: 'SET_FILTERS', patch: { sla: key as string | null } })}
          />
        </div>
      </div>

      <div className="levels">
        {levels.map(level => (
          <section key={level.priorityId} className="lvl">
            <div className="lvl__head" style={{ background: LEVEL_BG[level.priorityId] }}>
              <span>{level.title}</span>
              <span className="lvl__count" key={level.count}>{level.count}</span>
            </div>
            <div>
              {level.items.map(card => (
                <LevelCard key={card.id} card={card} />
              ))}
              {level.items.length === 0 && (
                <p style={{ color: 'var(--text-3)', fontSize: 13, padding: '14px 6px', textAlign: 'center' }}>Пусто</p>
              )}
            </div>
          </section>
        ))}
      </div>
    </>
  )
}
