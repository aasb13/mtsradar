import { useMemo } from 'react'
import { useDashboard, type FilterKey, type ViewMode } from '../store'
import { IconClose, IconSearch } from './Icons'

const VIEWS: { key: ViewMode; label: string }[] = [
  { key: 'board', label: 'Доска' },
  { key: 'groups', label: 'Группы' },
]

const CHIPS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'critical', label: 'Критические' },
  { key: 'coordinators', label: 'На координаторах' },
  { key: 'high_priority', label: 'Высокий приоритет' },
  { key: 'research', label: 'Исследование ситуации' },
]

const GROUP_KEYS = ['critical', 'coordinators', 'high_priority', 'research'] as const

export function FilterToolbar() {
  const { state, dispatch, searchRef } = useDashboard()

  const counts = useMemo(() => {
    const map = new Map<FilterKey, number>()
    map.set('all', state.incidents.length)
    for (const key of GROUP_KEYS) {
      map.set(key, state.incidents.filter(incident => incident.groups.includes(key)).length)
    }
    return map
  }, [state.incidents])

  return (
    <section className="toolbar" aria-label="Режим, фильтры и поиск">
      <div className="toolbar__views">
        {VIEWS.map(view => (
          <button
            key={view.key}
            type="button"
            className={`seg${state.view === view.key ? ' seg--active' : ''}`}
            onClick={() => dispatch({ type: 'SET_VIEW', view: view.key })}
          >
            {view.label}
          </button>
        ))}
      </div>
      <div className="toolbar__chips">
        {CHIPS.map(chip => (
          <button
            key={chip.key}
            type="button"
            className={`chip${state.filter === chip.key ? ' chip--active' : ''}`}
            onClick={() => dispatch({ type: 'SET_FILTER', filter: chip.key })}
          >
            {chip.label}
            <span className="chip__count">{counts.get(chip.key) ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="toolbar__search">
        <IconSearch size={15} className="toolbar__search-icon" />
        <input
          ref={searchRef}
          className="toolbar__input"
          type="text"
          placeholder="Поиск: id, продукт, сервис, исполнитель"
          value={state.search}
          onChange={e => dispatch({ type: 'SET_SEARCH', search: e.target.value })}
          aria-label="Поиск по инцидентам"
        />
        {state.search !== '' && (
          <button
            type="button"
            className="icon-btn icon-btn--small"
            onClick={() => dispatch({ type: 'SET_SEARCH', search: '' })}
            title="Очистить поиск"
          >
            <IconClose size={12} />
          </button>
        )}
      </div>
    </section>
  )
}
