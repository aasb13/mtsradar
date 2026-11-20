import { useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useDashboard } from '../store'
import { compareIncidents, GROUP_META, STAGES, FINAL_STAGE, liveSla } from '../format'
import { invalidReason, isTransitionAllowed, isTransitionInFlight, transitionStage } from '../transition'
import type { Incident } from '../types'
import { PriorityBadge } from './IncidentRow'
import { IconLock } from './Icons'

interface DraggingState {
  id: string
  fromStageId: number
}

/** Сначала критические, затем по SLA (просроченные/горящие выше), затем по дедлайну. */
function boardCompare(a: Incident, b: Incident, syncedAt: number | null, now: number): number {
  const ca = a.groups.includes('critical') ? 0 : 1
  const cb = b.groups.includes('critical') ? 0 : 1
  if (ca !== cb) return ca - cb
  return compareIncidents(a, b, syncedAt, now)
}

/**
 * Перелёт карточки между колонками: невидимый оригинал остаётся в новой
 * колонке, а видимый клон (position: fixed, не обрезается скроллом колонок)
 * летит из старой позиции в новую.
 */
function playFlight(el: HTMLElement, from: DOMRect, to: DOMRect): void {
  if (typeof el.animate !== 'function') return
  const clone = el.cloneNode(true) as HTMLElement
  clone.classList.remove('bcard--dragging')
  clone.classList.add('bcard--flight')
  clone.style.left = `${from.x}px`
  clone.style.top = `${from.y}px`
  clone.style.width = `${from.width}px`
  el.style.visibility = 'hidden'
  document.body.appendChild(clone)
  const cleanup = () => {
    clone.remove()
    el.style.visibility = ''
  }
  const anim = clone.animate(
    [
      { transform: 'translate(0, 0)' },
      { transform: `translate(${to.x - from.x}px, ${to.y - from.y}px)` },
    ],
    { duration: 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
  )
  anim.finished.then(cleanup).catch(cleanup)
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
  const locked = incident.stageId === FINAL_STAGE
  const moving = state.movingIds.includes(incident.id)
  const assignee = incident.assignedEmployee ?? '—'
  const context = incident.productName ?? incident.assignedGroupName ?? null

  return (
    <div
      className={`bcard${isDragging ? ' bcard--dragging' : ''}${locked ? ' bcard--locked' : ''}`}
      data-incident-id={incident.id}
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
          ? 'Инцидент полностью завершен — конечная колонка'
          : moving
            ? 'Перенос выполняется…'
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
  const lastHoverRef = useRef<{ stageId: number; valid: boolean } | null>(null)
  const dropHandledRef = useRef(false)
  const boardRef = useRef<HTMLDivElement | null>(null)
  const positionsRef = useRef(new Map<string, DOMRect>())

  const columns = useMemo(() => {
    const sorted = [...incidents].sort((a, b) => boardCompare(a, b, state.syncedAt, state.now))
    return STAGES.map(stage => ({ ...stage, cards: sorted.filter(incident => incident.stageId === stage.id) }))
  }, [incidents, state.syncedAt, state.now])

  // FLIP-анимация: после каждой отрисовки сравниваем позиции карточек и
  // запускаем перелёт для тех, кто сменил место (колонку или порядок).
  useLayoutEffect(() => {
    const board = boardRef.current
    if (board === null) return
    const previous = positionsRef.current
    const current = new Map<string, DOMRect>()
    for (const el of board.querySelectorAll<HTMLElement>('.bcard[data-incident-id]')) {
      const id = el.dataset.incidentId ?? ''
      const rect = el.getBoundingClientRect()
      const old = previous.get(id)
      if (old !== undefined && (Math.abs(old.x - rect.x) > 1 || Math.abs(old.y - rect.y) > 1)) {
        playFlight(el, old, rect)
      }
      current.set(id, rect)
    }
    positionsRef.current = current
  })

  const warnInvalid = (fromStageId: number, toStageId: number) => {
    dispatch({
      type: 'ADD_TOAST',
      toast: {
        key: `move-invalid|${fromStageId}|${toStageId}`,
        kind: 'move_invalid',
        type: 'warning',
        text: invalidReason(fromStageId, toStageId),
        sticky: false,
        createdAt: Date.now(),
      },
    })
  }

  const startTransition = (incidentId: string, targetStageId: number) => {
    if (isTransitionInFlight(incidentId)) return
    void transitionStage(incidentId, targetStageId, {
      onMoveStarted: id => dispatch({ type: 'MOVE_START', id }),
      onMoveFinished: id => dispatch({ type: 'MOVE_END', id }),
      onApplied: text =>
        dispatch({
          type: 'ADD_TOAST',
          toast: { key: `move|${incidentId}|${targetStageId}`, kind: 'move_ok', type: 'success', text, sticky: false, createdAt: Date.now() },
        }),
      onFailed: text =>
        dispatch({
          type: 'ADD_TOAST',
          toast: { key: `move-fail|${incidentId}|${targetStageId}`, kind: 'move_error', type: 'critical', text, sticky: false, createdAt: Date.now() },
        }),
      onResync: data => dispatch({ type: 'RESYNC', incidents: data }),
    })
  }

  const handleDrop = (e: DragEvent<HTMLElement>, targetStageId: number) => {
    e.preventDefault()
    dropHandledRef.current = true
    if (dragging === null) return
    const { id, fromStageId } = dragging
    if (targetStageId === fromStageId) return
    if (!isTransitionAllowed(fromStageId, targetStageId)) {
      warnInvalid(fromStageId, targetStageId)
      return
    }
    startTransition(id, targetStageId)
  }

  const handleDragEnd = () => {
    const hovered = lastHoverRef.current
    if (!dropHandledRef.current && hovered !== null && !hovered.valid && dragging !== null && hovered.stageId !== dragging.fromStageId) {
      warnInvalid(dragging.fromStageId, hovered.stageId)
    }
    setDragging(null)
    lastHoverRef.current = null
    dropHandledRef.current = false
  }

  const handleColumnDragOver = (e: DragEvent<HTMLElement>, colStageId: number) => {
    if (dragging === null) return
    const isSource = dragging.fromStageId === colStageId
    const valid = !isSource && isTransitionAllowed(dragging.fromStageId, colStageId)
    lastHoverRef.current = { stageId: colStageId, valid: isSource ? true : valid }
    if (valid) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    } else {
      e.dataTransfer.dropEffect = 'none'
    }
  }

  const handleColumnDragLeave = (e: DragEvent<HTMLElement>, colStageId: number) => {
    const next = e.relatedTarget
    if (next === null || !(e.currentTarget as HTMLElement).contains(next as Node)) {
      if (lastHoverRef.current?.stageId === colStageId) lastHoverRef.current = null
    }
  }

  return (
    <div ref={boardRef} className="board" aria-label="Канбан-доска инцидентов">
      {columns.map(col => {
        const isSource = dragging !== null && dragging.fromStageId === col.id
        const valid = dragging !== null && !isSource && isTransitionAllowed(dragging.fromStageId, col.id)
        const disabled = dragging !== null && !isSource && !valid
        return (
          <section
            key={col.id}
            className={`bcol${valid ? ' bcol--drop' : ''}${disabled ? ' bcol--disabled' : ''}`}
            onDragOver={e => handleColumnDragOver(e, col.id)}
            onDragLeave={e => handleColumnDragLeave(e, col.id)}
            onDrop={e => handleDrop(e, col.id)}
          >
            <div className={`bcol__head ${col.cls}`}>
              <span className="bcol__dot" />
              <span className="bcol__name" title={col.label}>
                {col.label}
              </span>
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
                    setDragging({ id: card.id, fromStageId: col.id })
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
