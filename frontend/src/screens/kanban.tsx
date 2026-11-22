import { useMemo, useState } from 'react'
import { compareCards, liveSla, priorityMeta, todayWeekday } from '../format'
import { navigate } from '../router'
import { filterCards, useApp } from '../store'
import { SyncBadge, SyncSub } from './shell'
import type { Card } from '../types'
import { BOARD_COLUMNS, TRANSITIONS } from '../types'
import { ChevronDownIcon, DotsIcon, EyeIcon, SeverityBadge, SlaChip, SnowflakeIcon, TeamIcon } from '../ui'

const PRIORITY_TONE_BG: Record<number, string> = {
  4: 'var(--red)',
  3: 'var(--orange)',
  2: 'var(--yellow)',
  1: 'var(--gray)',
}

const COLUMN_DOTS: Record<string, string> = {
  todo: 'var(--gray)',
  work: 'var(--blue)',
  review: 'var(--orange)',
  done: 'var(--green)',
}

export function FilterChipMenu({
  label,
  value,
  active = false,
  options,
  onSelect,
}: {
  label: string
  value: string
  active?: boolean
  options: { key: string | number | null; label: string }[]
  onSelect: (key: string | number | null) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <span
      className={`fchip ${active ? 'fchip--active' : ''}`}
      onClick={() => setOpen(!open)}
    >
      <span className="fchip__label">{label}</span>
      <span className="fchip__value">{value}</span>
      <ChevronDownIcon size={14} />
      {open && (
        <span className="fchip-menu" onClick={e => e.stopPropagation()}>
          {options.map(o => (
            <button
              key={String(o.key)}
              type="button"
              className={value === o.label ? 'fchip-menu__sel' : ''}
              onClick={() => {
                setOpen(false)
                onSelect(o.key)
              }}
            >
              {o.label}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}

export function KpiRow() {
  const { state } = useApp()
  const kpi = state.kpi
  const cards = useMemo(() => [...state.cards.values()], [state.cards])
  const hourAgo = state.now - 3600000
  const createdLastHour = cards.filter(c => {
    const t = c.submitDate === null ? NaN : Date.parse(c.submitDate)
    return !Number.isNaN(t) && t >= hourAgo && c.isActive
  }).length
  const firstCritical = cards.find(c => c.isCritical && c.isActive && !c.isResolved)
  const firstBreached = cards.find(c => c.isActive && c.sla.state === 'breached')
  if (kpi === null) return null
  return (
    <div className="kpis">
      <div className="kpi">
        <p className="kpi__label">Открыто</p>
        <p className="kpi__value" key={kpi.active}>{kpi.active}</p>
        <p className="kpi__sub">{createdLastHour > 0 ? `+${createdLastHour} за час` : 'без изменений за час'}</p>
      </div>
      <div className="kpi">
        <p className="kpi__label">Критических</p>
        <p className="kpi__value kpi__value--red" key={kpi.critical}>{kpi.critical}</p>
        <p className="kpi__sub">{firstCritical !== undefined ? firstCritical.id : '—'}</p>
      </div>
      <div className="kpi">
        <p className="kpi__label">Просрочено</p>
        <p className="kpi__value kpi__value--red" key={kpi.breached}>{kpi.breached}</p>
        <p className="kpi__sub">{firstBreached !== undefined ? firstBreached.id : '—'}</p>
      </div>
      <div className="kpi">
        <p className="kpi__label">Решено сегодня</p>
        <p className="kpi__value kpi__value--red" key={kpi.resolvedToday}>{kpi.resolvedToday}</p>
        <p className="kpi__sub">{state.resolvedYesterday > 0 ? `+${kpi.resolvedToday - state.resolvedYesterday} к вчера` : '—'}</p>
      </div>
    </div>
  )
}

export function CriticalBanner() {
  const { state, dispatch, doAck } = useApp()
  const cards = [...state.cards.values()]
  const criticalId = state.unacknowledgedCritical.length > 0 ? state.unacknowledgedCritical[0] : null
  const card = criticalId !== null ? cards.find(c => c.id === criticalId) : undefined
  if (card === undefined) return null
  const sla = liveSla(card, state.now)
  return (
    <div
      className="critbanner"
      onClick={() => dispatch({ type: 'OPEN_PANEL', id: card.id })}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && dispatch({ type: 'OPEN_PANEL', id: card.id })}
    >
      <div>
        <p className="critbanner__title">Критический инцидент {card.id} · {card.header ?? 'без названия'}</p>
        <p className="critbanner__sub">
          {card.productName ?? '—'} · {card.service ?? '—'} · {sla.label} · {card.assignedGroupName !== null ? card.assignedGroupName : 'команда не назначена'}
        </p>
      </div>
      <div className="critbanner__actions">
        <button
          type="button"
          className="btn btn--white btn--sm"
          onClick={e => {
            e.stopPropagation()
            dispatch({ type: 'OPEN_PANEL', id: card.id })
          }}
        >
          <EyeIcon size={15} />
          Открыть
        </button>
        <button
          type="button"
          className="btn btn--plain btn--sm"
          onClick={e => {
            e.stopPropagation()
            dispatch({ type: 'OPEN_ASSIGN', id: card.id })
          }}
        >
          <TeamIcon size={15} />
          Назначить
        </button>
        <button
          type="button"
          className="btn btn--plain btn--sm"
          title="Принять в работу — баннер погаснет для всех координаторов"
          onClick={e => {
            e.stopPropagation()
            void doAck(card.id)
          }}
        >
          Принят
        </button>
      </div>
    </div>
  )
}

export function IncidentCard({ card, draggable = false, onDragStart, onDragEnd }: {
  card: Card
  draggable?: boolean
  onDragStart?: () => void
  onDragEnd?: () => void
}) {
  const { state, dispatch } = useApp()
  const frozen = card.freeze != null
  const critical = card.isCritical && card.isActive && !card.isResolved
  const overdue = !critical && card.sla.state === 'breached'
  return (
    <div
      className={`icard ${critical ? 'icard--critical' : ''} ${overdue ? 'icard--overdue' : ''}`}
      style={{ borderLeftColor: critical ? undefined : PRIORITY_TONE_BG[card.priorityId] ?? 'var(--gray)' }}
      draggable={draggable}
      onDragStart={e => {
        e.dataTransfer.setData('text/plain', card.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart?.()
      }}
      onDragEnd={onDragEnd}
      onClick={() => dispatch({ type: 'OPEN_PANEL', id: card.id })}
    >
      <div className="icard__top">
        <span className="icard__id">{card.id}</span>
        {card.isNewCritical && <span className="icard__new">НОВЫЙ</span>}
        {frozen && (
          <span className="frozenbadge">
            <SnowflakeIcon size={13} />
          </span>
        )}
        <SeverityBadge priorityId={card.priorityId} />
      </div>
      <p className="icard__title">{card.header ?? 'Без названия'}</p>
      <div className="icard__assignee">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="8" r="4" />
          <path d="M5 21c0-4 3-6 7-6s7 2 7 6" />
        </svg>
        {card.assignedEmployee !== null && card.assignedEmployee !== '' ? card.assignedEmployee : 'Не назначен'}
      </div>
      <div className="icard__extra">
        <SlaChip card={card} now={state.now} frozen={frozen} />
        {card.stateId === 20 && <span>Статус: Исследование</span>}
      </div>
    </div>
  )
}

export function KanbanPage() {
  const { state, dispatch, doTransition, showToast } = useApp()
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropColumn, setDropColumn] = useState<string | null>(null)

  const cards = useMemo(
    () => filterCards([...state.cards.values()], state.search, state.filters).sort((a, b) => compareCards(a, b)),
    [state.cards, state.search, state.filters, state.now],
  )

  // первый BOOT_OK ещё не пришёл — не рисуем пустую доску (после хуков: их порядок не должен зависеть от данных)
  if (state.dictionaries === null) {
    return <p className="loading-text" style={{ color: 'var(--text-2)', padding: 24 }}>Загрузка…</p>
  }

  const columns = BOARD_COLUMNS.map(column => ({
    ...column,
    cards: cards.filter(c => column.stateIds.includes(c.stateId)),
  }))

  const drop = (columnKey: string, cardId: string) => {
    const card = state.cards.get(cardId)
    const column = BOARD_COLUMNS.find(c => c.key === columnKey)
    if (card === undefined || column === undefined) return
    const allowed = TRANSITIONS[card.stateId] ?? []
    const target = column.stateIds.find(id => allowed.includes(id) && id !== card.stateId)
    if (target === undefined) {
      const names = column.stateIds.map(id => (id === 0 ? '«К выполнению» (Назначен)' : id === 20 ? '«Исследование»' : id === 2 ? '«В работе»' : id === 7 ? '«На проверке»' : '«Закрыт»'))
      showToast(`Переход из «${card.state ?? card.stateId}» в ${names.join(' / ')} запрещён правилами`, 'warning')
      return
    }
    void doTransition(card, target)
  }

  const filtersActive =
    state.filters.priorityId !== null || state.filters.product !== null || state.filters.team !== null || state.filters.sla !== null || state.search !== ''

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
          <button type="button" className="tabs__tab tabs__tab--active">Канбан</button>
          <button type="button" className="tabs__tab" onClick={() => navigate('/attention')}>
            Группы внимания
          </button>
        </div>
        <div className="fchips">
          <FilterChipMenu
            label="Приоритет"
            value={state.filters.priorityId === null ? 'Все' : priorityMeta(state.filters.priorityId).label}
            options={[
              { key: null, label: 'Все' },
              { key: 4, label: 'Критический' },
              { key: 3, label: 'Высокий' },
              { key: 2, label: 'Средний' },
              { key: 1, label: 'Низкий' },
            ]}
            onSelect={key => dispatch({ type: 'SET_FILTERS', patch: { priorityId: key as number | null } })}
          />
          <FilterChipMenu
            label="Продукт"
            value={state.filters.product ?? 'Все'}
            options={[{ key: null, label: 'Все' }, ...(state.dictionaries?.products ?? []).map(p => ({ key: p, label: p }))]}
            onSelect={key => dispatch({ type: 'SET_FILTERS', patch: { product: key as string | null } })}
          />
          <FilterChipMenu
            label="Команда"
            value={state.filters.team ?? 'Все'}
            options={[{ key: null, label: 'Все' }, ...(state.dictionaries?.assignedGroups ?? []).map(t => ({ key: t, label: t }))]}
            onSelect={key => dispatch({ type: 'SET_FILTERS', patch: { team: key as string | null } })}
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

      {cards.length === 0 ? (
        <div className="empty">
          <span className="empty__icon">
            <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 13h5l2 3h4l2-3h5" />
              <path d="M5 5h14l2 8v6H3v-6l2-8Z" />
            </svg>
          </span>
          <p className="empty__title">{filtersActive ? 'Под фильтры ничего не попало' : 'Инцидентов нет'}</p>
          <p>Все задачи обработаны или ещё не поступили на смену</p>
          {filtersActive && (
            <button
              type="button"
              className="btn btn--secondary"
              style={{ marginTop: 16 }}
              onClick={() => {
                dispatch({ type: 'SET_FILTERS', patch: { priorityId: null, product: null, team: null, sla: null } })
                dispatch({ type: 'SET_SEARCH', search: '' })
              }}
            >
              Сбросить фильтры
            </button>
          )}
        </div>
      ) : (
        <div className="board">
          {columns.map(column => (
            <section
              key={column.key}
              className={`column ${dropColumn === column.key && dragId !== null ? 'column--droppable' : ''}`}
              onDragOver={e => {
                e.preventDefault()
                setDropColumn(column.key)
              }}
              onDragLeave={() => setDropColumn(c => (c === column.key ? null : c))}
              onDrop={e => {
                e.preventDefault()
                setDropColumn(null)
                const id = e.dataTransfer.getData('text/plain')
                if (id !== '') drop(column.key, id)
              }}
            >
              <div className="column__head">
                <span className="column__dot" style={{ background: COLUMN_DOTS[column.key] }} />
                <span className="column__title">{column.title}</span>
                <span className="column__count" key={column.cards.length}>{column.cards.length}</span>
                <span className="column__spacer" />
                <span style={{ color: 'var(--text-3)', display: 'flex' }}>
                  <DotsIcon size={16} />
                </span>
              </div>
              <div className="column__cards">
                {column.cards.map(card => (
                  <IncidentCard key={card.id} card={card} draggable onDragStart={() => setDragId(card.id)} onDragEnd={() => setDragId(null)} />
                ))}
                {column.cards.length === 0 && (
                  <p style={{ color: 'var(--text-3)', fontSize: 13, padding: '18px 6px', textAlign: 'center' }}>
                    {dragId !== null ? 'Отпустите карточку здесь' : 'Пусто'}
                  </p>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  )
}

export const SLA_LABELS: Record<string, string> = {
  ok: 'В норме',
  warning: 'Близко к сроку',
  danger: 'Горит',
  breached: 'Просрочен',
  none: 'Без срока',
}
