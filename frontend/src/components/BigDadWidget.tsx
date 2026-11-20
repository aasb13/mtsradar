import { useEffect, useRef, useState } from 'react'
import { useDashboard } from '../store'
import { fetchAiRisk } from '../api'
import { compareIncidents, formatDurationWords, riskClass } from '../format'
import { IconSparkle } from './Icons'

interface RadarEntry {
  id: string
  score: number | null
  reason: string
  failed: boolean
}

function Skeleton({ lines }: { lines: number }) {
  return (
    <div className="skeleton-group">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  )
}

export function BigDadWidget() {
  const { state, dispatch } = useDashboard()
  const summary = state.summary
  const [entries, setEntries] = useState<RadarEntry[] | null>(null)
  const cacheRef = useRef<{ gen: string; entries: RadarEntry[] }>({ gen: '', entries: [] })

  useEffect(() => {
    if (summary === null) return
    const gen = summary.generatedAt
    if (cacheRef.current.gen === gen) {
      setEntries(cacheRef.current.entries)
      return
    }
    const criticals = state.incidents
      .filter(incident => incident.groups.includes('critical'))
      .sort((a, b) => compareIncidents(a, b, state.syncedAt, state.now))
      .slice(0, 5)
    if (criticals.length === 0) {
      cacheRef.current = { gen, entries: [] }
      setEntries([])
      return
    }
    let cancelled = false
    setEntries(null)
    void Promise.allSettled(criticals.map(c => fetchAiRisk(c.id))).then(results => {
      const list: RadarEntry[] = results.map((result, i) => {
        if (result.status === 'fulfilled') {
          return { id: criticals[i].id, score: result.value.score, reason: result.value.reason, failed: false }
        }
        console.error('Не удалось получить риск-оценку', result.reason)
        return { id: criticals[i].id, score: null, reason: 'Не удалось получить оценку риска', failed: true }
      })
      list.sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
      if (!cancelled) {
        cacheRef.current = { gen, entries: list }
        setEntries(list)
      }
    })
    return () => {
      cancelled = true
    }
  }, [summary])

  if (summary === null) return null
  const shift = summary.shift

  const stats: { label: string; value: string }[] = [
    { label: 'Открыто сегодня', value: shift.openedToday.toLocaleString('ru-RU') },
    { label: 'Решено сегодня', value: shift.resolvedToday.toLocaleString('ru-RU') },
    {
      label: 'Среднее время решения',
      value: shift.avgResolutionMinutes === null ? '—' : formatDurationWords(shift.avgResolutionMinutes * 60),
    },
    { label: 'Просрочено', value: summary.kpi.breached.toLocaleString('ru-RU') },
  ]

  return (
    <section className="bigdad" aria-label="Сводка смены">
      <div className="bigdad__head">
        <IconSparkle size={18} className="bigdad__icon" />
        <h2 className="bigdad__title">Сводка смены — BigDad</h2>
      </div>
      <div className="bigdad__stats">
        {stats.map(stat => (
          <div key={stat.label} className="bigdad__stat">
            <span className="bigdad__num">{stat.value}</span>
            <span className="bigdad__label">{stat.label}</span>
          </div>
        ))}
      </div>
      <div className="bigdad__top">
        Топ-продукт смены: <strong>{shift.topProduct ?? '—'}</strong>
      </div>
      <div className="bigdad__radar">
        <div className="bigdad__radar-title">Риск-радар критических инцидентов</div>
        {entries === null ? (
          <Skeleton lines={3} />
        ) : entries.length === 0 ? (
          <div className="bigdad__empty">Критических инцидентов нет — радар пуст</div>
        ) : (
          entries.map(entry => (
            <button
              key={entry.id}
              type="button"
              className="bigdad__radar-item"
              onClick={() => dispatch({ type: 'OPEN_DRAWER', id: entry.id })}
            >
              <span className="bigdad__radar-id">{entry.id}</span>
              {entry.failed || entry.score === null ? (
                <span className="bigdad__radar-score">Н/Д</span>
              ) : (
                <span className={`bigdad__radar-score bigdad__radar-score--${riskClass(entry.score)}`}>
                  {entry.score}/100
                </span>
              )}
              <span className="bigdad__radar-reason">{entry.reason}</span>
            </button>
          ))
        )}
      </div>
    </section>
  )
}
