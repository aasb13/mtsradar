import { useMemo } from 'react'
import { useDashboard } from '../store'
import { compareIncidents } from '../format'
import type { Incident, IncidentGroup } from '../types'
import { IncidentRow } from './IncidentRow'

export const GROUP_ORDER: IncidentGroup[] = ['critical', 'coordinators', 'high_priority', 'research']

const GROUP_TITLE: Record<IncidentGroup, string> = {
  critical: 'Критические инциденты',
  coordinators: 'Назначены на координаторов',
  high_priority: 'Высокий приоритет',
  research: 'Исследование ситуации',
}

interface Props {
  group: IncidentGroup
  incidents: Incident[]
}

export function GroupSection({ group, incidents }: Props) {
  const { state, dispatch } = useDashboard()

  const sorted = useMemo(
    () => [...incidents].sort((a, b) => compareIncidents(a, b, state.syncedAt, state.now)),
    [incidents, state.syncedAt, state.now],
  )

  return (
    <section className="section" id={`section-${group}`}>
      <div className="section__head">
        <h2 className="section__title">{GROUP_TITLE[group]}</h2>
        <span className="section__count">{sorted.length}</span>
      </div>
      <div className="section__rows">
        {sorted.map(incident => (
          <IncidentRow key={incident.id} incident={incident} onOpen={id => dispatch({ type: 'OPEN_DRAWER', id })} />
        ))}
      </div>
    </section>
  )
}
