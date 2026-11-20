import { useDashboard, type FilterKey } from '../store'
import type { Kpi } from '../types'

interface Tile {
  key: keyof Kpi
  label: string
  filter: FilterKey | null
}

const TILES: Tile[] = [
  { key: 'open', label: 'Открыто', filter: 'all' },
  { key: 'critical', label: 'Критических', filter: 'critical' },
  { key: 'breached', label: 'Просрочено', filter: 'breached' },
  { key: 'research', label: 'На исследовании', filter: 'research' },
  { key: 'coordinators', label: 'У координаторов', filter: 'coordinators' },
  { key: 'resolvedToday', label: 'Решено сегодня', filter: null },
]

export function KpiStrip() {
  const { state, dispatch } = useDashboard()
  const kpi = state.summary?.kpi ?? null
  return (
    <section className="kpi" aria-label="Ключевые показатели смены">
      {TILES.map(tile => {
        const filter = tile.filter
        const value = kpi === null ? '—' : kpi[tile.key].toLocaleString('ru-RU')
        const active = filter !== null && filter !== 'all' && state.filter === filter
        return (
          <button
            key={tile.key}
            type="button"
            className={`kpi__tile${filter === null ? ' kpi__tile--static' : ''}${active ? ' kpi__tile--active' : ''}`}
            onClick={
              filter === null
                ? undefined
                : () => dispatch({ type: 'SET_FILTER', filter: state.filter === filter ? 'all' : filter })
            }
            disabled={filter === null}
            title={filter === null ? undefined : 'Показать эти инциденты'}
          >
            <span className="kpi__value">{value}</span>
            <span className="kpi__label">{tile.label}</span>
          </button>
        )
      })}
    </section>
  )
}
