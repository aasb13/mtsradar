import { useEffect, useState } from 'react'
import { useDashboard } from '../store'
import { fetchAiRisk, fetchAiSummary, fetchAiTeam } from '../api'
import { formatFull, riskClass } from '../format'
import type { AiRisk, AiSummary, AiTeam, Incident } from '../types'
import { PriorityBadge, StatusBadge } from './IncidentRow'
import { IconClose, IconExternal, IconRefresh, IconSparkle } from './Icons'

interface AiBundle {
  loading: boolean
  summary: AiSummary | null
  summaryError: boolean
  risk: AiRisk | null
  riskError: boolean
  team: AiTeam | null
  teamError: boolean
}

const EMPTY_BUNDLE: AiBundle = {
  loading: false,
  summary: null,
  summaryError: false,
  risk: null,
  riskError: false,
  team: null,
  teamError: false,
}

/** Кэш ответов ИИ по паре «инцидент + срез данных» (generatedAt). */
const aiCache = new Map<string, AiBundle>()

const FLAG_META: { field: keyof Incident; label: string }[] = [
  { field: 'isMaster', label: 'Мастер-инцидент' },
  { field: 'isEffect', label: 'Следствие' },
  { field: 'isRootIncident', label: 'Корневой инцидент' },
  { field: 'isDouble', label: 'Дубль' },
]

function Skeleton({ lines }: { lines: number }) {
  return (
    <div className="skeleton-group">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  )
}

function AiSection({
  label,
  loading,
  error,
  errorText,
  children,
}: {
  label: string
  loading: boolean
  error: boolean
  errorText: string
  children: React.ReactNode
}) {
  return (
    <div className="ai-block__section">
      <div className="ai-block__label">{label}</div>
      {loading ? (
        <Skeleton lines={2} />
      ) : error ? (
        <div className="ai-block__error">{errorText}</div>
      ) : (
        children
      )}
    </div>
  )
}

export function IncidentDrawer() {
  const { state, dispatch } = useDashboard()
  const [bundle, setBundle] = useState<AiBundle>(EMPTY_BUNDLE)
  const [refreshNonce, setRefreshNonce] = useState(0)

  const incident =
    state.drawerId === null ? null : (state.incidents.find(i => i.id === state.drawerId) ?? null)

  useEffect(() => {
    if (incident === null) return
    const key = `${incident.id}|${state.generatedAt ?? ''}`
    const cached = aiCache.get(key)
    if (cached !== undefined) {
      setBundle(cached)
      return
    }
    let cancelled = false
    setBundle({ ...EMPTY_BUNDLE, loading: true })
    const id = incident.id
    void Promise.allSettled([fetchAiSummary(id), fetchAiRisk(id), fetchAiTeam(id)]).then(([summary, risk, team]) => {
      for (const result of [summary, risk, team]) {
        if (result.status === 'rejected') console.error('Ошибка запроса к ИИ', result.reason)
      }
      const next: AiBundle = {
        loading: false,
        summary: summary.status === 'fulfilled' ? summary.value : null,
        summaryError: summary.status === 'rejected',
        risk: risk.status === 'fulfilled' ? risk.value : null,
        riskError: risk.status === 'rejected',
        team: team.status === 'fulfilled' ? team.value : null,
        teamError: team.status === 'rejected',
      }
      if (!cancelled) {
        aiCache.set(key, next)
        setBundle(next)
      }
    })
    return () => {
      cancelled = true
    }
  }, [incident, state.generatedAt, refreshNonce])

  if (incident === null) return null

  const facts: { label: string; value: string }[] = [
    { label: 'Продукт', value: incident.productName ?? '—' },
    { label: 'Сервис', value: incident.service ?? '—' },
    { label: 'Сценарий', value: incident.scenarioName ?? '—' },
    { label: 'Тип', value: incident.incType ?? '—' },
    { label: 'Канал поступления', value: incident.receivingChannel ?? '—' },
    { label: 'Инициатор', value: incident.initiatorName ?? '—' },
    { label: 'Исполнитель', value: incident.assignedEmployee ?? '—' },
    { label: 'Группа исполнителя', value: incident.assignedGroupName ?? '—' },
    { label: 'Зарегистрирован', value: formatFull(incident.submitDate) },
    { label: 'Дедлайн', value: formatFull(incident.deadline) },
    { label: 'Решён', value: formatFull(incident.completionDate) },
    { label: 'Передано команде', value: formatFull(incident.lastAssignmentToTeamDateTime) },
  ]

  const flags = FLAG_META.filter(meta => incident[meta.field] === true)
  const solutionTitle = incident.stateId === 7 || incident.stateId === 10
    ? 'Решение'
    : 'Предыдущая попытка решения (не помогла)'

  const refreshAi = () => {
    aiCache.delete(`${incident.id}|${state.generatedAt ?? ''}`)
    setRefreshNonce(n => n + 1)
  }

  return (
    <>
      <div className="drawer__backdrop" onClick={() => dispatch({ type: 'CLOSE_DRAWER' })} />
      <aside className="drawer" role="dialog" aria-label={`Инцидент ${incident.id}`}>
        <div className="drawer__head">
          <div className="drawer__titles">
            <span className="drawer__id">{incident.id}</span>
            <h2 className="drawer__title">{incident.header}</h2>
            <div className="drawer__badges">
              <StatusBadge incident={incident} />
              <PriorityBadge incident={incident} />
            </div>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={() => dispatch({ type: 'CLOSE_DRAWER' })}
            title="Закрыть (Esc)"
          >
            <IconClose size={16} />
          </button>
        </div>

        {typeof incident.productUrl === 'string' && incident.productUrl !== '' && (
          <a className="btn btn--itsm" href={incident.productUrl} target="_blank" rel="noreferrer">
            Открыть в ITSM
            <IconExternal size={14} />
          </a>
        )}

        <div className="facts">
          {facts.map(fact => (
            <div key={fact.label} className="facts__item">
              <span className="facts__label">{fact.label}</span>
              <span className="facts__value">{fact.value}</span>
            </div>
          ))}
        </div>

        {flags.length > 0 && (
          <div className="drawer__flags">
            {flags.map(meta => (
              <span key={meta.label} className="tag tag-flag">
                {meta.label}
              </span>
            ))}
          </div>
        )}

        <div className="drawer__block">
          <h3 className="drawer__block-title">Описание</h3>
          <p className="drawer__text">{incident.description ?? incident.shortDescription ?? '—'}</p>
        </div>

        <div className="drawer__block">
          <h3 className="drawer__block-title">{solutionTitle}</h3>
          <p className="drawer__text">{incident.solution ?? '—'}</p>
        </div>

        <div className="ai-block">
          <div className="ai-block__head">
            <IconSparkle size={16} className="ai-block__icon" />
            <span className="ai-block__title">BigDad — ИИ-анализ инцидента</span>
            <button
              type="button"
              className="icon-btn icon-btn--small"
              onClick={refreshAi}
              title="Обновить анализ"
            >
              <IconRefresh size={14} />
            </button>
          </div>

          <AiSection
            label="Объяснить, что произошло"
            loading={bundle.loading}
            error={bundle.summaryError}
            errorText="Не удалось получить объяснение. Нажмите «Обновить»."
          >
            <p className="ai-block__text">{bundle.summary?.text ?? '—'}</p>
          </AiSection>

          <AiSection
            label="Оценка риска"
            loading={bundle.loading}
            error={bundle.riskError}
            errorText="Не удалось получить оценку риска. Нажмите «Обновить»."
          >
            {bundle.risk !== null && (
              <div className="risk">
                <div className="risk__bar">
                  <div
                    className={`risk__fill risk__fill--${riskClass(bundle.risk.score)}`}
                    style={{ width: `${Math.min(100, Math.max(0, bundle.risk.score))}%` }}
                  />
                </div>
                <span className="risk__num">{bundle.risk.score}/100</span>
              </div>
            )}
            <p className="ai-block__text">{bundle.risk?.reason ?? '—'}</p>
          </AiSection>

          <AiSection
            label="Кому передать?"
            loading={bundle.loading}
            error={bundle.teamError}
            errorText="Не удалось получить рекомендацию. Нажмите «Обновить»."
          >
            <p className="ai-block__text ai-block__text--strong">{bundle.team?.team ?? '—'}</p>
            <p className="ai-block__text">{bundle.team?.reason ?? '—'}</p>
          </AiSection>
        </div>
      </aside>
    </>
  )
}
