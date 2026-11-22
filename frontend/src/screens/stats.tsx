import { Fragment, useEffect, useMemo, useState } from 'react'
import { formatMinutes } from '../format'
import { useApp } from '../store'
import { exportUrl, fetchTeamDescriptions, refreshTeamDescriptions } from '../api'
import { PRIORITY_SLA_HOURS } from '../types'
import type { TeamAiDescription } from '../types'
import { Avatar, Button, DownloadIcon, SeverityBadge, SparkIcon } from '../ui'

type Period = 'week' | 'month' | 'quarter'

const PERIOD_DAYS: Record<Period, number> = { week: 7, month: 30, quarter: 90 }

interface DayPoint {
  day: number
  created: number
  resolved: number
}

function DailyChart({ points }: { points: DayPoint[] }) {
  const width = 1180
  const height = 300
  const padX = 36
  const padY = 18
  const max = Math.max(4, ...points.map(p => Math.max(p.created, p.resolved)))
  const stepX = points.length > 1 ? (width - padX * 2) / (points.length - 1) : 0
  const yOf = (v: number) => padY + (1 - v / max) * (height - padY * 2)
  const path = (key: 'created' | 'resolved') =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(padX + i * stepX).toFixed(1)},${yOf(p[key]).toFixed(1)}`).join(' ')
  const gridLines = [0, max / 2, max]
  const labels = [0, 4, 8, 12, 16, 20].filter(i => i < points.length)
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      {gridLines.map((v, i) => (
        <g key={i}>
          <line x1={padX} x2={width - padX} y1={yOf(v)} y2={yOf(v)} stroke="var(--border-soft)" strokeWidth="1" />
          <text x={4} y={yOf(v) + 4} fontSize="11" fill="var(--text-3)">
            {Math.round(v)}
          </text>
        </g>
      ))}
      <path d={path('created')} fill="none" stroke="var(--violet)" strokeWidth="2.5" />
      <path d={path('resolved')} fill="none" stroke="var(--chart-2)" strokeWidth="2.5" />
      {points.map((p, i) => (
        <g key={p.day}>
          <circle cx={padX + i * stepX} cy={yOf(p.created)} r="3" fill="var(--violet)" />
          <circle cx={padX + i * stepX} cy={yOf(p.resolved)} r="3" fill="var(--chart-2)" />
        </g>
      ))}
      {labels.map(i => {
        const day = new Date(points[i].day)
        return (
          <text key={i} x={padX + i * stepX} y={height - 2} fontSize="11" fill="var(--text-3)" textAnchor="middle">
            {new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(day)}
          </text>
        )
      })}
    </svg>
  )
}

export function StatsPage() {
  const { state } = useApp()
  const aiEnabled = state.dictionaries?.aiEnabled !== false
  const [period, setPeriod] = useState<Period>('month')
  const cards = useMemo(() => [...state.cards.values()], [state.cards])
  const resolvedCards = useMemo(() => cards.filter(c => c.isResolved), [cards])
  const [descriptions, setDescriptions] = useState<Record<string, TeamAiDescription>>({})
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetchTeamDescriptions()
        if (!cancelled) setDescriptions(Object.fromEntries(res.descriptions.map(d => [d.group, d])))
      } catch (err) {
        console.error('Не удалось загрузить ИИ-описания команд', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const refreshDescriptions = async () => {
    if (aiBusy) return
    setAiBusy(true)
    setAiError(null)
    try {
      const res = await refreshTeamDescriptions()
      setDescriptions(Object.fromEntries(res.descriptions.map(d => [d.group, d])))
    } catch (err) {
      console.error('Не удалось обновить ИИ-описания команд', err)
      setAiError('BigDad сейчас не смог описать команды, попробуйте ещё раз')
    } finally {
      setAiBusy(false)
    }
  }

  const windowStart = useMemo(() => {
    const d = new Date(state.now)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - PERIOD_DAYS[period])
    return d.getTime()
  }, [period, state.now])

  const points = useMemo<DayPoint[]>(() => {
    const list: DayPoint[] = []
    for (let i = 0; i <= PERIOD_DAYS[period]; i += 1) {
      const d = new Date(windowStart + i * 86400000)
      d.setHours(0, 0, 0, 0)
      list.push({ day: d.getTime(), created: 0, resolved: 0 })
    }
    const index = new Map<number, DayPoint>()
    for (const p of list) index.set(p.day, p)
    const bucket = (iso: string | null): number | null => {
      if (iso === null) return null
      const t = Date.parse(iso)
      if (Number.isNaN(t)) return null
      const d = new Date(t)
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    }
    for (const card of cards) {
      const day = bucket(card.submitDate)
      if (day !== null) {
        const point = index.get(day)
        if (point !== undefined) point.created += 1
      }
      const done = bucket(card.completionDate)
      if (done !== null) {
        const point = index.get(done)
        if (point !== undefined) point.resolved += 1
      }
    }
    return list
  }, [cards, windowStart, period])

  const periodCreated = points.reduce((sum, p) => sum + p.created, 0)
  const periodResolved = points.reduce((sum, p) => sum + p.resolved, 0)

  const avgResolutionPeriod = useMemo(() => {
    const minutes: number[] = []
    for (const card of resolvedCards) {
      if (card.completionDate === null || card.submitDate === null) continue
      const from = Date.parse(card.submitDate)
      const to = Date.parse(card.completionDate)
      if (Number.isNaN(from) || Number.isNaN(to) || to < windowStart) continue
      minutes.push((to - from) / 60000)
    }
    return minutes.length === 0 ? null : minutes.reduce((a, b) => a + b, 0) / minutes.length
  }, [resolvedCards, windowStart])

  const slaMet = useMemo(() => {
    let withDeadline = 0
    let met = 0
    for (const card of resolvedCards) {
      if (card.completionDate === null || card.submitDate === null || card.deadline === null) continue
      const to = Date.parse(card.completionDate)
      if (Number.isNaN(to) || to < windowStart) continue
      withDeadline += 1
      if (to <= Date.parse(card.deadline)) met += 1
    }
    return withDeadline === 0 ? null : Math.round((met / withDeadline) * 100)
  }, [resolvedCards, windowStart])

  const breachedNow = useMemo(
    () => cards.filter(c => c.isActive && c.sla.state === 'breached').length,
    [cards],
  )

  const teams = useMemo(() => {
    const groups = Object.keys(state.stats?.active.byAssignedGroup ?? {})
    const known = new Set([...groups, ...state.dictionaries?.assignedGroups ?? []])
    known.delete('')
    return [...known]
      .map(name => {
        const active = cards.filter(c => c.isActive && c.assignedGroupName === name).length
        const resolvedList = resolvedCards.filter(c => c.assignedGroupName === name)
        const minutes = resolvedList
          .filter(c => c.completionDate !== null && c.submitDate !== null)
          .map(c => (Date.parse(c.completionDate as string) - Date.parse(c.submitDate as string)) / 60000)
        const avg = minutes.length === 0 ? null : minutes.reduce((a, b) => a + b, 0) / minutes.length
        const withDeadline = resolvedList.filter(c => c.deadline !== null && c.completionDate !== null)
        const metRate =
          withDeadline.length === 0
            ? null
            : Math.round(
                (withDeadline.filter(c => Date.parse(c.completionDate as string) <= Date.parse(c.deadline as string)).length /
                  withDeadline.length) *
                  100,
              )
        return { name, active, resolved: resolvedList.length, avg, metRate }
      })
      .filter(t => t.active > 0 || t.resolved > 0)
      .sort((a, b) => b.active - a.active)
  }, [cards, resolvedCards, state.stats, state.dictionaries])

  const maxTeamLoad = Math.max(1, ...teams.map(t => t.active))

  const topDevelopers = useMemo(() => {
    const map = new Map<string, { name: string; done: number; minutes: number[] }>()
    for (const card of resolvedCards) {
      const who = card.assignedEmployee
      if (who === null || who === undefined || who === '') continue
      const entry = map.get(who) ?? { name: who, done: 0, minutes: [] }
      entry.done += 1
      if (card.completionDate !== null && card.submitDate !== null) {
        entry.minutes.push((Date.parse(card.completionDate) - Date.parse(card.submitDate)) / 60000)
      }
      map.set(who, entry)
    }
    return [...map.values()]
      .sort((a, b) => b.done - a.done)
      .slice(0, 5)
      .map(entry => ({
        ...entry,
        avg: entry.minutes.length === 0 ? null : entry.minutes.reduce((a, b) => a + b, 0) / entry.minutes.length,
      }))
  }, [resolvedCards])

  const slaVsPriority = useMemo(() => {
    return [4, 3, 2, 1]
      .map(priorityId => {
        const list = resolvedCards.filter(c => c.priorityId === priorityId)
        const minutes = list
          .filter(c => c.completionDate !== null && c.submitDate !== null)
          .map(c => (Date.parse(c.completionDate as string) - Date.parse(c.submitDate as string)) / 60000)
        const avg = minutes.length === 0 ? null : minutes.reduce((a, b) => a + b, 0) / minutes.length
        return { priorityId, avg, budget: PRIORITY_SLA_HOURS[priorityId] * 60, count: list.length }
      })
      .filter(row => row.count > 0)
  }, [resolvedCards])

  const monthLabel = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(state.now)
  const monthName = monthLabel.split(' ')[0]
  const monthCapital = monthName.charAt(0).toUpperCase() + monthName.slice(1)

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Статистика</h1>
          <p className="pagehead__sub">
            {monthCapital} {state.now ? new Date(state.now).getFullYear() : ''} · все продукты и команды
          </p>
        </div>
        <div className="pagehead__actions">
          <div className="tabs">
            {(['week', 'month', 'quarter'] as Period[]).map(p => (
              <button key={p} type="button" className={`tabs__tab ${period === p ? 'tabs__tab--active' : ''}`} onClick={() => setPeriod(p)}>
                {p === 'week' ? 'Неделя' : p === 'month' ? 'Месяц' : 'Квартал'}
              </button>
            ))}
          </div>
          <a className="btn btn--secondary" href={exportUrl()} download>
            <DownloadIcon size={15} />
            Экспорт
          </a>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi">
          <p className="kpi__label">Инцидентов за период</p>
          <p className="kpi__value">{periodCreated}</p>
          <p className="kpi__sub">решено за период: {periodResolved}</p>
        </div>
        <div className="kpi">
          <p className="kpi__label">Среднее время решения</p>
          <p className="kpi__value">{formatMinutes(avgResolutionPeriod)}</p>
          <p className="kpi__sub">по {periodResolved} решённым</p>
        </div>
        <div className="kpi">
          <p className="kpi__label">SLA выполнен</p>
          <p className="kpi__value">{slaMet === null ? '—' : `${slaMet}%`}</p>
          <p className="kpi__sub">решено в срок до дедлайна</p>
        </div>
        <div className="kpi">
          <p className="kpi__label">Просрочено</p>
          <p className="kpi__value kpi__value--red">{breachedNow}</p>
          <p className="kpi__sub">активные сейчас</p>
        </div>
      </div>

      <div className="chartcard" style={{ marginTop: 24 }}>
        <div className="chartcard__head">
          <h3>Инциденты по дням</h3>
          <div className="legend">
            <span>
              <span className="legend__dot" style={{ background: 'var(--violet)' }} />
              Создано
            </span>
            <span>
              <span className="legend__dot" style={{ background: 'var(--chart-2)' }} />
              Решено
            </span>
          </div>
        </div>
        <DailyChart points={points} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '8px 0 16px' }}>
        <h3 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Команды</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {aiError !== null && <span style={{ color: 'var(--red)', fontSize: 13 }}>{aiError}</span>}
          <Button
            variant={aiEnabled ? 'secondary' : 'danger'}
            disabled={aiBusy || !aiEnabled}
            title={aiEnabled ? undefined : 'BigDad не подключён — ИИ-описания команд недоступны'}
            onClick={() => void refreshDescriptions()}
          >
            <SparkIcon size={14} />
            {aiBusy ? 'BigDad описывает команды…' : aiEnabled ? 'ИИ-описания команд' : 'BigDad не подключён'}
          </Button>
        </div>
      </div>
      <div className="tablecard" style={{ marginBottom: 28 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Команда</th>
              <th>Активных</th>
              <th>Решено</th>
              <th>Ср. время</th>
              <th>SLA</th>
              <th style={{ width: 260 }}>Загрузка</th>
            </tr>
          </thead>
          <tbody>
            {teams.map(team => (
              <Fragment key={team.name}>
                <tr>
                  <td className="table__title">{team.name}</td>
                  <td>{team.active}</td>
                  <td>{team.resolved}</td>
                  <td>{formatMinutes(team.avg)}</td>
                  <td>{team.metRate === null ? '—' : `${team.metRate}%`}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div className="loadbar" style={{ flex: 1, marginTop: 0 }}>
                        <span className="loadbar__fill loadbar__fill--violet" style={{ width: `${Math.round((team.active / maxTeamLoad) * 100)}%` }} />
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 600, minWidth: 38 }}>{Math.round((team.active / maxTeamLoad) * 100)}%</span>
                    </div>
                  </td>
                </tr>
                {descriptions[team.name] !== undefined && (
                  <tr className="teamrow-ai">
                    <td colSpan={6}>
                      <span className="teamrow-ai__spark">
                        <SparkIcon size={13} />
                      </span>
                      {descriptions[team.name].text}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {teams.length === 0 && (
              <tr>
                <td colSpan={6} style={{ color: 'var(--text-2)' }}>
                  В данных нет назначенных команд
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="statsgrid">
        <div className="statcard">
          <h3>Топ-5 исполнителей</h3>
          {topDevelopers.map((dev, index) => (
            <div key={dev.name} className={`toprow ${index === 0 ? 'toprow--first' : ''}`}>
              <span className="toprow__rank">{index + 1}</span>
              <Avatar tone={index === 0 ? 'blue' : 'ghost'} name={dev.name} />
              <div>
                <p className="toprow__name">{dev.name}</p>
                <p className="toprow__role">исполнитель</p>
              </div>
              <div className="toprow__right">
                <b>{dev.done} решено</b>
                ср. {formatMinutes(dev.avg)}
              </div>
            </div>
          ))}
          {topDevelopers.length === 0 && <p style={{ color: 'var(--text-2)' }}>В решённых инцидентах нет исполнителей</p>}
        </div>
        <div className="statcard">
          <h3>Время решения vs SLA</h3>
          {slaVsPriority.map(row => (
            <div key={row.priorityId} className="slabar-row">
              <SeverityBadge priorityId={row.priorityId} />
              <div className="loadbar">
                <span
                  className="loadbar__fill loadbar__fill--violet"
                  style={{ width: `${Math.min(100, Math.round(((row.avg ?? 0) / row.budget) * 100))}%` }}
                />
              </div>
              <div className="slabar-row__right">
                <b>{formatMinutes(row.avg)}</b> <span>из {row.budget / 60} ч</span>
              </div>
            </div>
          ))}
          {slaVsPriority.length === 0 && <p style={{ color: 'var(--text-2)' }}>Нет решённых инцидентов</p>}
        </div>
      </div>
    </>
  )
}
