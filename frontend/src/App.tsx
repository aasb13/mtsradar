import { useEffect, useMemo } from 'react'
import { DashboardProvider, matchFilter, useDashboard } from './store'
import { Header } from './components/Header'
import { KpiStrip } from './components/KpiStrip'
import { CriticalRibbon } from './components/CriticalRibbon'
import { FilterToolbar } from './components/FilterToolbar'
import { GROUP_ORDER, GroupSection } from './components/GroupSection'
import { IncidentDrawer } from './components/IncidentDrawer'
import { BigDadWidget } from './components/BigDadWidget'
import { ToastStack } from './components/ToastStack'
import { ShortcutsModal } from './components/ShortcutsModal'
import type { Incident } from './types'

export default function App() {
  return (
    <DashboardProvider>
      <Dashboard />
    </DashboardProvider>
  )
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

function Dashboard() {
  const { state, dispatch, searchRef } = useDashboard()

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
        e.preventDefault()
        searchRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        searchRef.current?.focus()
        return
      }
      if (e.key === 'Escape') {
        if (state.shortcutsOpen) dispatch({ type: 'TOGGLE_SHORTCUTS' })
        else if (state.drawerId !== null) dispatch({ type: 'CLOSE_DRAWER' })
        else if (!state.ribbonDismissed) dispatch({ type: 'DISMISS_RIBBON' })
        return
      }
      if (isTypingTarget(e.target)) return
      if (e.key === '?') {
        e.preventDefault()
        dispatch({ type: 'TOGGLE_SHORTCUTS' })
        return
      }
      if (e.key >= '1' && e.key <= '4') {
        const group = GROUP_ORDER[Number(e.key) - 1]
        if (group === undefined) return
        document.getElementById(`section-${group}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [state.shortcutsOpen, state.drawerId, state.ribbonDismissed, dispatch, searchRef])

  const visible = useMemo(() => {
    const query = state.search.trim().toLowerCase()
    return state.incidents.filter(incident => {
      if (!matchFilter(incident, state.filter, state.syncedAt, state.now)) return false
      if (query === '') return true
      return [incident.id, incident.header, incident.productName, incident.service, incident.assignedEmployee, incident.assignedGroupName]
        .some(value => typeof value === 'string' && value.toLowerCase().includes(query))
    })
  }, [state.incidents, state.filter, state.search, state.syncedAt, state.now])

  const sections = GROUP_ORDER.map(group => ({
    group,
    rows: visible.filter((incident: Incident) => incident.groups.includes(group)),
  }))
  const hasRows = sections.some(section => section.rows.length > 0)

  return (
    <div className="app">
      <Header />
      <main className="main">
        {state.bootError !== null && state.incidents.length === 0 ? (
          <div className="boot-error">
            <p>{state.bootError}</p>
            <button type="button" className="btn btn--primary" onClick={() => dispatch({ type: 'RELOAD' })}>
              Повторить
            </button>
          </div>
        ) : (
          <>
            <KpiStrip />
            <CriticalRibbon />
            <FilterToolbar />
            {hasRows ? (
              sections.map(section =>
                section.rows.length > 0 ? (
                  <GroupSection key={section.group} group={section.group} incidents={section.rows} />
                ) : null,
              )
            ) : (
              <div className="empty">
                <p>По текущим фильтрам инцидентов нет</p>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    dispatch({ type: 'SET_FILTER', filter: 'all' })
                    dispatch({ type: 'SET_SEARCH', search: '' })
                  }}
                >
                  Сбросить фильтры
                </button>
              </div>
            )}
            <BigDadWidget />
          </>
        )}
      </main>
      <IncidentDrawer />
      <ToastStack />
      <ShortcutsModal />
    </div>
  )
}
