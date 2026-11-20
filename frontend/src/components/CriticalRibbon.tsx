import { useMemo, useState } from 'react'
import { useDashboard } from '../store'
import { compareIncidents, liveSla } from '../format'
import { IconChevron, IconClose, IconWarning } from './Icons'

const CRITICAL_SHOW_LIMIT = 3

export function CriticalRibbon() {
  const { state, dispatch } = useDashboard()
  const [expanded, setExpanded] = useState(false)

  const criticals = useMemo(
    () =>
      state.incidents
        .filter(incident => incident.groups.includes('critical'))
        .sort((a, b) => compareIncidents(a, b, state.syncedAt, state.now)),
    [state.incidents, state.syncedAt, state.now],
  )

  if (criticals.length === 0 || state.ribbonDismissed) return null

  const shown = expanded ? criticals : criticals.slice(0, CRITICAL_SHOW_LIMIT)
  const hidden = criticals.length - shown.length

  return (
    <section className="ribbon" role="alert" aria-label="Критические инциденты">
      <div className="ribbon__head">
        <IconWarning size={18} className="ribbon__icon" />
        <span className="ribbon__title">Критические инциденты</span>
        <span className="ribbon__count">{criticals.length}</span>
        <button
          type="button"
          className="icon-btn icon-btn--small"
          onClick={() => dispatch({ type: 'DISMISS_RIBBON' })}
          title="Скрыть до следующего нового критического инцидента"
        >
          <IconClose size={13} />
        </button>
      </div>
      <div className="ribbon__list">
        {shown.map(incident => {
          const sla = liveSla(incident, state.syncedAt, state.now)
          return (
            <div key={incident.id} className="ribbon__item">
              <span className="ribbon__id">{incident.id}</span>
              <span className="ribbon__header" title={incident.header}>
                {incident.header}
              </span>
              <span className={`sla sla--${sla.state}`}>{sla.label}</span>
              <button type="button" className="btn btn--small" onClick={() => dispatch({ type: 'OPEN_DRAWER', id: incident.id })}>
                Открыть
              </button>
            </div>
          )
        })}
      </div>
      {criticals.length > CRITICAL_SHOW_LIMIT && (
        <button type="button" className="ribbon__more" onClick={() => setExpanded(value => !value)}>
          <IconChevron size={13} className={expanded ? 'chev chev--open' : 'chev'} />
          {expanded ? 'Свернуть' : `+${hidden} ещё`}
        </button>
      )}
    </section>
  )
}
