import { useMemo, useRef, useState, type DragEvent } from 'react'
import { useDashboard } from '../store'
import { compareIncidents, GROUP_META, liveSla, statusClass } from '../format'
import { invalidReason, isTransitionAllowed, isTransitionInFlight, transitionState } from '../transition'
import type { Incident } from '../types'
import { PriorityBadge } from './IncidentRow'
import { IconLock } from './Icons'

const COLUMNS: { stateId: number; label: string }[] = [
  { stateId: 0, label: 'Назначен' },
  { stateId: 2, label: 'Выполняется' },
  { stateId: 7, label: 'Завершён' },
  { stateId: 20, label: 'Исследование ситуации' },
  { stateId: 10, label: 'Закрыт' },
]

const LOCKED_STATE_ID = 10

interface DraggingState {
  id: string
  fromStateId: number
}

/** Сначала критические, затем по SLA (просроченные/горящие выше), затем по дедлайну. */
function boardCompare(a: Incident, b: Incident, syncedAt: number | null, now: number): number {
  const ca = a.groups.includes('critical') ? 0 : 1
  const cb = b.groups.includes('critical') ? 0 : 1
  if (ca !== cb) return ca - cb
  return compareIncidents(a, b, syncedAt, now)
}

interface CardProps {
  incident: Incident
  isDragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onOpen: (id: string) => void
}

function KanbanCard({ incident, isDragging, onDragStart, onDragEnd, onOpen }: CardProps) {
  const { state } = useDashboard()
  const sla = liveSla(incident, state.syncedAt, state.now)
  const locked = incident.stateId === LOCKED_STATE_ID
  const moving = state.movingIds.includes(incident.id)
  const assignee = incident.assignedEmployee ?? '—'
  const context = incident.productName ?? incident.assignedGroupName ?? null

  return (
    <div
      className={`bcard${isDragging ? ' bcard--dragging' : ''}${locked ? ' bcard--locked' : ''}`}
      draggable={!locked && !moving}
      onDragStart={e => {
        e.dataTransfer.setData('text/plain', incident.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(incident.id)}
      onKeyDown={e => {
        if (e.key === 'Enter') onOpen(incident.id)
      }}
      role="button"
      tabIndex={0}
      title={
        locked
          ? 'Закрытый инцидент — конечный статус'
          : moving
            ? 'Изменение статуса выполняется…'
            : undefined
      }
    >
      <div className="bcard__top">
        <span className="bcard__id">{incident.id}</span>
        {moving && <span className="bcard__moving">Перенос…</span>}
        {locked && <IconLock size={13} className="bcard__lock" />}
      </div>
      <span className="bcard__title" title={incident.header}>
        {incident.header}
      </span>
      <div className="bcard__bottom">
        <PriorityBadge incident={incident} />
        <span className={`sla sla--${sla.state} bcard__sla`}>{sla.label}</span>
      </div>
      <div className="bcard__meta">
        <span>{assignee}</span>
        {context !== null && <span className="bcard__meta-sub">{context}</span>}
      </div>
      {incident.groups.length > 0 && (
        <div className="bcard__tags">
          {incident.groups.map(group => (
            <span key={group} className={`tag ${GROUP_META[group].cls}`}>
              {GROUP_META[group].label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

interface Props {
  incidents: Incident[]
}

export function KanbanBoard({ incidents }: Props) {
  const { state, dispatch } = useDashboard()
  const [dragging, setDragging] = useState<DraggingState | null>(null)
  const lastHoverRef = useRef<{ stateId: number; valid: boolean } | null>(null)
  const dropHandledRef = useRef(false)

  const columns = useMemo(() => {
    const sorted = [...incidents].sort((a, b) => boardCompare(a, b, state.syncedAt, state.now))
    return COLUMNS.map(col => ({ ...col, cards: sorted.filter(incident => incident.stateId === col.stateId) }))
  }, [incidents, state.syncedAt, state.now])

  const warnInvalid = (fromStateId: number, toStateId: number) => {
    dispatch({
      type: 'ADD_TOAST',
      toast: {
        key: `move-invalid|${fromStateId}|${toStateId}`,
        kind: 'move_invalid',
        type: 'warning',
        text: invalidReason(fromStateId, toStateId),
        sticky: false,
        createdAt: Date.now(),
      },
    })
  }

  const startTransition = (incidentId: string, targetStateId: number) => {
    if (isTransitionInFlight(incidentId)) return
    void transitionState(incidentId, targetStateId, {
      onMoveStarted: id => dispatch({ type: 'MOVE_START', id }),
      onMoveFinished: id => dispatch({ type: 'MOVE_END', id }),
      onApplied: text =>
        dispatch({
          type: 'ADD_TOAST',
          toast: { key: `move|${incidentId}|${targetStateId}`, kind: 'move_ok', type: 'success', text, sticky: false, createdAt: Date.now() },
        }),
      onFailed: text =>
        dispatch({
          type: 'ADD_TOAST',
          toast: { key: `move-fail|${incidentId}|${targetStateId}`, kind: 'move_error', type: 'critical', text, sticky: false, createdAt: Date.now() },
        }),
      onResync: data => dispatch({ type: 'RESYNC', incidents: data }),
    })
  }

  const handleDrop = (e: DragEvent<HTMLElement>, targetStateId: number) => {
    e.preventDefault()
    dropHandledRef.current = true
    if (dragging === null) return
    const { id, fromStateId } = dragging
    if (targetStateId === fromStateId) return
    if (!isTransitionAllowed(fromStateId, targetStateId)) {
      warnInvalid(fromStateId, targetStateId)
      return
    }
    startTransition(id, targetStateId)
  }

  const handleDragEnd = () => {
    const hovered = lastHoverRef.current
    if (!dropHandledRef.current && hovered !== null && !hovered.valid && dragging !== null && hovered.stateId !== dragging.fromStateId) {
      warnInvalid(dragging.fromStateId, hovered.stateId)
    }
    setDragging(null)
    lastHoverRef.current = null
    dropHandledRef.current = false
  }

  const handleColumnDragOver = (e: DragEvent<HTMLElement>, colStateId: number) => {
    if (dragging === null) return
    const isSource = dragging.fromStateId === colStateId
    const valid = !isSource && isTransitionAllowed(dragging.fromStateId, colStateId)
    lastHoverRef.current = { stateId: colStateId, valid: isSource ? true : valid }
    if (valid) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    } else {
      e.dataTransfer.dropEffect = 'none'
    }
  }

  const handleColumnDragLeave = (e: DragEvent<HTMLElement>, colStateId: number) => {
    const next = e.relatedTarget
    if (next === null || !(e.currentTarget as HTMLElement).contains(next as Node)) {
      if (lastHoverRef.current?.stateId === colStateId) lastHoverRef.current = null
    }
  }

  return (
    <div className="board" aria-label="Канбан-доска инцидентов">
      {columns.map(col => {
        const isSource = dragging !== null && dragging.fromStateId === col.stateId
        const valid = dragging !== null && !isSource && isTransitionAllowed(dragging.fromStateId, col.stateId)
        const disabled = dragging !== null && !isSource && !valid
        return (
          <section
            key={col.stateId}
            className={`bcol${valid ? ' bcol--drop' : ''}${disabled ? ' bcol--disabled' : ''}`}
            onDragOver={e => handleColumnDragOver(e, col.stateId)}
            onDragLeave={e => handleColumnDragLeave(e, col.stateId)}
            onDrop={e => handleDrop(e, col.stateId)}
          >
            <div className={`bcol__head ${statusClass(col.stateId)}`}>
              <span className="bcol__dot" />
              <span className="bcol__name">{col.label}</span>
              <span className="bcol__count">{col.cards.length}</span>
            </div>
            <div className="bcol__body">
              {col.cards.length === 0 && <div className="bcol__empty" />}
              {col.cards.map(card => (
                <KanbanCard
                  key={card.id}
                  incident={card}
                  isDragging={dragging?.id === card.id}
                  onDragStart={() => {
                    dropHandledRef.current = false
                    setDragging({ id: card.id, fromStateId: card.stateId })
                  }}
                  onDragEnd={handleDragEnd}
                  onOpen={id => dispatch({ type: 'OPEN_DRAWER', id })}
                />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
