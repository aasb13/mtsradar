import { useDashboard } from '../store'
import { formatShort, liveSla, priorityMeta, statusClass, statusLabel, GROUP_META } from '../format'
import type { Incident } from '../types'

export function StatusBadge({ incident }: { incident: Incident }) {
  return <span className={`badge ${statusClass(incident.stateId)}`}>{statusLabel(incident)}</span>
}

export function PriorityBadge({ incident }: { incident: Incident }) {
  const meta = priorityMeta(incident.priorityId)
  return <span className={`badge ${meta.cls}`}>{meta.label}</span>
}

interface Props {
  incident: Incident
  onOpen: (id: string) => void
}

export function IncidentRow({ incident, onOpen }: Props) {
  const { state } = useDashboard()
  const sla = liveSla(incident, state.syncedAt, state.now)
  const productLine = [incident.productName, incident.service].filter(Boolean).join(' · ')
  const multipleGroups = incident.groups.length > 1

  return (
    <div
      className="row"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(incident.id)}
      onKeyDown={e => {
        if (e.key === 'Enter') onOpen(incident.id)
      }}
    >
      <div className="row__main">
        <span className="row__id">{incident.id}</span>
        <span className="row__header" title={incident.header}>
          {incident.header}
        </span>
        {productLine !== '' && (
          <span className="row__sub" title={productLine}>
            {productLine}
          </span>
        )}
      </div>
      <div className="row__cell">
        <span className="row__label">Зарегистрирован</span>
        <span>{formatShort(incident.submitDate)}</span>
      </div>
      <div className="row__cell">
        <span className="row__label">Исполнитель</span>
        <span className="row__value">{incident.assignedEmployee ?? '—'}</span>
        {incident.assignedGroupName !== null && <span className="row__sub">{incident.assignedGroupName}</span>}
      </div>
      <div className="row__cell">
        <span className="row__label">Статус</span>
        <StatusBadge incident={incident} />
      </div>
      <div className="row__cell">
        <span className="row__label">Приоритет</span>
        <PriorityBadge incident={incident} />
      </div>
      <div className="row__tags">
        {multipleGroups &&
          incident.groups.map(group => (
            <span key={group} className={`tag ${GROUP_META[group].cls}`}>
              {GROUP_META[group].label}
            </span>
          ))}
      </div>
      <div className={`sla sla--${sla.state}`}>{sla.label}</div>
    </div>
  )
}
