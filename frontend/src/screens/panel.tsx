import { Fragment, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import * as api from '../api'
import { formatShort, liveSla, relativeTime, shortName, slaBigValue } from '../format'
import { navigate } from '../router'
import { useApp } from '../store'
import type { FreezeRequest } from '../store'
import type { AiAlternative, Card, Comment, HistoryEvent, IncidentDetail } from '../types'
import { ArrowRightIcon, Avatar, Button, CloseIcon, CommentIcon, LinkIcon, Markdown, Modal, RefreshIcon, Select, SeverityBadge, SlaChip, SnowflakeIcon, SparkIcon, StatusPill, stringOptions, Textarea, TeamIcon } from '../ui'

const HISTORY_TEXT: Record<string, string> = {
  created: 'Инцидент зарегистрирован',
  acknowledged: 'Координатор принял инцидент в работу',
  imported: 'Обновлено из выгрузки ITSM',
}

function changeTransition(label: string, from: string, to: string): ReactNode {
  return (
    <span className="history__change">
      {label}: {from} <ArrowRightIcon size={12} /> {to}
    </span>
  )
}

function changesText(event: HistoryEvent): ReactNode {
  const parts: ReactNode[] = []
  for (const change of event.changes) {
    const field = typeof change.field === 'string' ? change.field : null
    if (field === null) continue
    const to = change.to
    const from = change.from
    if (field === 'stateId' || field === 'state') {
      parts.push(changeTransition('Статус', String(from ?? '—'), String(to ?? '—')))
    } else if (field === 'priorityId' || field === 'priority') {
      parts.push(changeTransition('Приоритет', String(from ?? '—'), String(to ?? '—')))
    } else if (field === 'deadline') {
      parts.push(changeTransition('Срок', formatShort(typeof from === 'string' ? from : null), formatShort(typeof to === 'string' ? to : null)))
    } else if (field === 'assignedGroupName') {
      parts.push(changeTransition('Команда', typeof from === 'string' && from !== '' ? from : '—', typeof to === 'string' && to !== '' ? to : '—'))
    } else if (field === 'members') {
      const added = Array.isArray(change.added) ? change.added.length : 0
      const removed = Array.isArray(change.removed) ? change.removed.length : 0
      if (added > 0) parts.push(`Добавлены участники: ${added}`)
      if (removed > 0) parts.push(`Убраны участники: ${removed}`)
    } else {
      parts.push(`${field}: изменено`)
    }
  }
  if (event.type === 'created') return HISTORY_TEXT.created
  if (event.type === 'acknowledged') return HISTORY_TEXT.acknowledged
  if (event.type === 'imported') return HISTORY_TEXT.imported
  if (event.type === 'frozen') {
    const reason = typeof event.reason === 'string' && event.reason !== '' ? event.reason : null
    return reason === null ? 'SLA заморожен' : `SLA заморожен: ${reason}`
  }
  if (event.type === 'unfrozen') return 'SLA разморожен — срок сдвинут'
  if (parts.length === 0) return HISTORY_TEXT[event.type] ?? 'Событие'
  return parts.map((part, i) => <Fragment key={i}>{i > 0 ? ' · ' : null}{part}</Fragment>)
}

function slaHoursOf(card: Card): number | null {
  const total = card.sla.totalSeconds
  if (total === null || total === undefined || !Number.isFinite(total)) return null
  return Math.round((total / 3600) * 2) / 2
}

function descriptionOf(detail: IncidentDetail | null, meta: Record<string, unknown>): string {
  const fromMeta = typeof meta.description === 'string' ? meta.description : ''
  if (fromMeta !== '') return fromMeta
  const fromDetail = detail !== null && typeof detail.data.description === 'string' ? (detail.data.description as string) : ''
  if (fromDetail !== '') return fromDetail
  const short = typeof meta.shortDescription === 'string' ? meta.shortDescription : ''
  return short !== '' ? short : '—'
}

export function IncidentPanel() {
  const { state, dispatch, showToast, doAssign, doUnfreeze } = useApp()
  const id = state.panelId
  const [detail, setDetail] = useState<IncidentDetail | null>(null)
  const [history, setHistory] = useState<HistoryEvent[]>([])
  const [comments, setComments] = useState<Comment[]>([])
  const [commentOpen, setCommentOpen] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const card = id !== null ? state.cards.get(id) ?? null : null

  useEffect(() => {
    if (id === null) {
      setDetail(null)
      setHistory([])
      setComments([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const d = await api.fetchIncident(id)
        if (!cancelled) setDetail(d)
        const h = await api.fetchHistory(id)
        if (!cancelled) setHistory(h)
        const c = await api.fetchComments(id)
        if (!cancelled) setComments(c)
      } catch (err) {
        console.error('Не удалось загрузить карточку инцидента', err)
        if (!cancelled) showToast('Не удалось загрузить карточку инцидента', 'warning')
      }
    })()
    const onComment = (e: Event) => {
      const comment = (e as CustomEvent<Comment>).detail
      if (comment.incidentId === id) setComments(prev => [...prev, comment])
    }
    window.addEventListener('radar:comment', onComment)
    return () => {
      cancelled = true
      window.removeEventListener('radar:comment', onComment)
    }
  }, [id, showToast])

  if (id === null || card === null) return null
  const frozen = card.freeze != null
  const sla = liveSla(card, state.now)
  const ai = detail?.ai ?? null
  const aiEnabled = state.dictionaries?.aiEnabled !== false
  const meta = (detail?.data ?? {}) as Record<string, unknown>
  const initiator = typeof meta.initiatorName === 'string' ? meta.initiatorName : null
  const canAct = state.user?.role === 'coordinator' || state.user?.role === 'admin'

  const submitComment = async () => {
    const text = commentText.trim()
    if (text === '') return
    try {
      const created = await api.addComment(card.id, text)
      setComments(prev => [...prev, created])
      setCommentText('')
      setCommentOpen(false)
    } catch (err) {
      console.error('Не удалось отправить комментарий', err)
      showToast('Не удалось отправить комментарий', 'warning')
    }
  }

  // прямой ответ на предложение BigDad: принять (назначить) или обсудить в чате с контекстом
  const acceptRecommendation = async (group: string) => {
    await doAssign(card, group, null)
  }

  const discussInChat = () => {
    const draft =
      ai !== null && ai.recommendedGroup !== null
        ? `Инцидент ${card.id}: BigDad рекомендует команду «${ai.recommendedGroup}»${ai.recommendedReason !== null ? ` — ${ai.recommendedReason}` : ''}. Проверь, насколько это надёжно, и если всё в порядке — передай инцидент этой команде.`
        : `Расскажи подробнее про инцидент ${card.id}: что происходит, какие риски и что делать дальше.`
    navigate(`/chat?incident=${encodeURIComponent(card.id)}&draft=${encodeURIComponent(draft)}`)
  }

  const close = () => dispatch({ type: 'OPEN_PANEL', id: null })

  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && close()}>
      <aside className="panel">
        <div className="panel__top">
          <span className="panel__id">{card.id}</span>
          <SeverityBadge priorityId={card.priorityId} />
          <StatusPill card={card} />
          {frozen && (
            <span className="pill pill--frozen">
              <SnowflakeIcon size={12} />
              Заморожен
            </span>
          )}
          <span className="panel__topspacer" />
          <a className="iconbtn" href={card.itsmUrl} target="_blank" rel="noreferrer" title="Открыть в ITSM">
            <LinkIcon size={16} />
          </a>
          <button type="button" className="iconbtn" aria-label="Закрыть" onClick={close}>
            <CloseIcon size={16} />
          </button>
        </div>

        <h2>{card.header ?? 'Без названия'}</h2>

        <div className="slabox">
          <span className="slabox__icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </span>
          <div>
            <p className="slabox__label">{sla.state === 'breach' ? 'Просрочен' : frozen ? 'Пауза SLA' : sla.state === 'resolved' ? 'Решён' : 'До дедлайна'}</p>
            <p className={`slabox__time ${sla.state === 'breach' ? 'slabox__time--red' : ''}`}>
              {slaBigValue(card, state.now)}
            </p>
          </div>
          <div className="slabox__right">
            <b>SLA {slaHoursOf(card) === null ? '—' : `${slaHoursOf(card)} ч`}</b>
            дедлайн {formatShort(card.deadline)}
          </div>
        </div>

        {canAct && (
          <div className="panel__actions">
            <Button variant="primary" className="btn--sm" onClick={() => dispatch({ type: 'OPEN_ASSIGN', id: card.id })}>
              <TeamIcon size={15} />
              Назначить команду
            </Button>
            <Button
              variant="secondary"
              className="btn--sm"
              onClick={() => {
                if (frozen) void doUnfreeze(card.id)
                else dispatch({ type: 'OPEN_FREEZE', id: card.id })
              }}
            >
              <SnowflakeIcon size={15} />
              {frozen ? 'Разморозить' : 'Заморозить'}
            </Button>
            <Button variant="ghost" className="btn--sm" onClick={() => setCommentOpen(!commentOpen)}>
              <CommentIcon size={15} />
              Комментарий
            </Button>
            <span className="spacer" />
            <Button
              variant="ghost"
              className="btn--sm"
              onClick={() => {
                void (async () => {
                  try {
                    await api.deleteIncident(card.id)
                    dispatch({ type: 'REMOVE_CARD', id: card.id })
                    close()
                    showToast(`${card.id} отменён`, 'info')
                  } catch (err) {
                    console.error('Не удалось отменить инцидент', err)
                    showToast('Не удалось отменить инцидент', 'warning')
                  }
                })()
              }}
            >
              Отменить
            </Button>
          </div>
        )}

        {commentOpen && (
          <div className="commentform">
            <Textarea
              style={{ minHeight: 60, flex: 1 }}
              value={commentText}
              placeholder="Комментарий для команды и координаторов…"
              onChange={e => setCommentText(e.target.value)}
            />
            <Button variant="primary" onClick={() => void submitComment()}>
              Отправить
            </Button>
          </div>
        )}

        <div className="pgrid">
          <div>
            <p className="pgrid__label">Продукт</p>
            <p className="pgrid__value">{card.productName ?? '—'}</p>
          </div>
          <div>
            <p className="pgrid__label">Где произошло</p>
            <p className="pgrid__value">{card.service ?? '—'}</p>
          </div>
          <div>
            <p className="pgrid__label">Создан</p>
            <p className="pgrid__value">
              {formatShort(card.submitDate)}
              {initiator !== null && initiator !== '' ? ` · ${initiator}` : ''}
            </p>
          </div>
          <div>
            <p className="pgrid__label">Координатор</p>
            <p className="pgrid__value">
              <Avatar size="sm" tone="ghost" />
              {card.acknowledged?.name ?? state.user?.fullName ?? '—'}
            </p>
          </div>
          <div>
            <p className="pgrid__label">Команда</p>
            <p className={`pgrid__value ${card.assignedGroupName === null ? 'pgrid__value--red' : ''}`}>
              {card.assignedGroupName ?? 'Не назначена'}
            </p>
          </div>
          <div>
            <p className="pgrid__label">Исполнитель</p>
            <p className="pgrid__value">{card.assignedEmployee ?? '—'}</p>
          </div>
        </div>

        <p className="psection">Описание</p>
        <p className="psection__text">{descriptionOf(detail, meta)}</p>

        {ai !== null && (ai.summary !== null || ai.riskScore !== null) && (
          <div className={`bigdad ${aiEnabled ? '' : 'bigdad--off'}`}>
            <div className="bigdad__head">
              <span className="bigdad__icon">
                <SparkIcon size={17} />
              </span>
              <div>
                <p className="bigdad__title">BigDad · ИИ-ассистент</p>
                <p className="bigdad__sub">обновлено {relativeTime(card.updatedAt, state.now)}</p>
              </div>
              <button
                type="button"
                className="bigdad__refresh"
                disabled={aiBusy}
                onClick={() => {
                  setAiBusy(true)
                  void (async () => {
                    try {
                      await api.requestAiRefresh(card.id)
                      showToast('BigDad обновит анализ через несколько секунд', 'info')
                    } catch (err) {
                      if (err instanceof Error && err.message !== '') showToast(err.message, 'warning')
                      else showToast('Не удалось запросить обновление анализа', 'warning')
                    } finally {
                      setAiBusy(false)
                    }
                  })()
                }}
              >
                <RefreshIcon size={14} />
                Обновить
              </button>
            </div>
            {!aiEnabled && <p className="bigdad__offnote">BigDad не подключён — ИИ-анализ недоступен</p>}
            {ai.summary !== null && <Markdown className="bigdad__text" text={ai.summary} />}
            {ai.riskScore !== null && (
              <>
                <div className="bigdad__risk">
                  <span>Риск эскалации</span>
                  <b>{ai.riskScore} / 100</b>
                </div>
                <div className="riskbar">
                  <span className="riskbar__fill" style={{ width: `${Math.min(100, ai.riskScore)}%` }} />
                </div>
                {ai.riskReason !== null && <Markdown className="bigdad__note" text={ai.riskReason} />}
              </>
            )}
            {ai.recommendedGroup !== null && (
              <div className="bigdad__team">
                <span className="bigdad__icon">
                  <SparkIcon size={15} />
                </span>
                <div>
                  <b>Кому передать: {ai.recommendedGroup}</b>
                  {ai.recommendedReason !== null && <Markdown text={ai.recommendedReason} />}
                </div>
              </div>
            )}
            {aiEnabled && (
              <div className="bigdad__reply">
                {ai.recommendedGroup !== null && (
                  <Button
                    variant="primary"
                    className="btn--sm"
                    onClick={() => {
                      const group = ai.recommendedGroup
                      if (group !== null) void acceptRecommendation(group)
                    }}
                  >
                    Принять: передать на {ai.recommendedGroup}
                  </Button>
                )}
                <Button variant="ghost" className="btn--sm" onClick={discussInChat}>
                  Обсудить в чате
                </Button>
              </div>
            )}
          </div>
        )}

        <div className="history">
          <div className="history__head">
            <h3>История</h3>
            <a
              href="#history"
              onClick={e => {
                e.preventDefault()
                void (async () => {
                  try {
                    const h = await api.fetchHistory(card.id)
                    setHistory(h)
                  } catch (err) {
                    console.error('Не удалось обновить историю', err)
                  }
                })()
              }}
            >
              Все {history.length} событий
            </a>
          </div>
          {history.slice(0, 12).map(event => (
            <div key={event.id} className="history__item">
              <Avatar size="sm" tone="ghost" />
              <div>
                <p>
                  <span className="history__name">{event.actor?.name ?? 'Система'}</span>{' '}
                  <span className="history__time">· {formatShort(event.at)}</span>
                </p>
                <p className="history__text">{changesText(event)}</p>
              </div>
            </div>
          ))}
        </div>

        {comments.length > 0 && (
          <div className="history">
            <div className="history__head">
              <h3>Комментарии</h3>
            </div>
            {comments.map(c => (
              <div key={c.id} className="history__item">
                <Avatar size="sm" tone="ghost" />
                <div>
                  <p>
                    <span className="history__name">{c.author?.name ?? '—'}</span>{' '}
                    <span className="history__time">· {formatShort(c.createdAt)}</span>
                  </p>
                  <p className="history__text">{c.text}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  )
}

interface DevRow {
  id: string
  name: string
  login: string
  load: number
  done: number
}

interface Recommendation {
  group: string
  reason: string | null
  confidence: number | null
  alternatives: AiAlternative[]
}

export function AssignModal() {
  const { state, dispatch, doAssign } = useApp()
  const id = state.assignId
  const card = id !== null ? state.cards.get(id) ?? null : null
  const aiEnabled = state.dictionaries?.aiEnabled !== false
  const [team, setTeam] = useState<string | null>(null)
  const [executor, setExecutor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [devs, setDevs] = useState<DevRow[]>([])
  const [recommended, setRecommended] = useState<Recommendation | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  useEffect(() => {
    if (card !== null) {
      setTeam(card.assignedGroupName)
      setExecutor(null)
    }
  }, [card])

  useEffect(() => {
    if (id === null) return
    let cancelled = false
    setRecommended(null)
    setAiError(null)
    setAiBusy(false)
    void (async () => {
      try {
        const detail = await api.fetchIncident(id)
        if (cancelled) return
        const saved = detail.ai?.recommendedGroup
        if (saved !== null && saved !== undefined && saved !== '') {
          setRecommended({
            group: saved,
            reason: detail.ai?.recommendedReason ?? null,
            confidence: detail.ai?.recommendedConfidence ?? null,
            alternatives: detail.ai?.recommendedAlternatives ?? [],
          })
          return
        }
        if (!aiEnabled) return // BigDad не подключён — красную плашку рисует рендер, агента не зовём
        // рекомендации ещё нет — просим агента подобрать команду (это до минуты)
        setAiBusy(true)
        const rec = await api.requestTeamRecommendation(id)
        if (cancelled) return
        setRecommended({ group: rec.recommendedGroup, reason: rec.reason, confidence: rec.confidence, alternatives: rec.alternatives })
      } catch (err) {
        if (cancelled) return
        console.error('Не удалось получить рекомендацию BigDad', err)
        setAiError(err instanceof api.ApiError && err.message !== '' ? err.message : 'BigDad сейчас не смог подобрать команду')
      } finally {
        if (!cancelled) setAiBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, aiEnabled])

  useEffect(() => {
    if (id === null) return
    let cancelled = false
    void (async () => {
      try {
        const users = await api.fetchUsers()
        const developers = users.filter(u => u.role === 'developer' && u.deletedAt === null)
        const all = [...state.cards.values()]
        const rows: DevRow[] = developers.map(dev => {
          const active = all.filter(
            c => c.isActive && ((dev.itsmLogin !== null && c.assignedEmployeeLogin === dev.itsmLogin) || c.members.includes(dev.id)),
          ).length
          const done = all.filter(c => c.isResolved && dev.itsmLogin !== null && c.assignedEmployeeLogin === dev.itsmLogin).length
          return { id: dev.id, name: dev.fullName ?? dev.email, login: dev.itsmLogin ?? '', load: active, done }
        })
        if (!cancelled) setDevs(rows)
      } catch (err) {
        console.error('Не удалось загрузить разработчиков', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, state.cards])

  const teams = state.dictionaries?.assignedGroups ?? []
  const statsGroups = useMemo(() => state.stats?.active.byAssignedGroup ?? {}, [state.stats])
  const maxLoad = Math.max(1, ...Object.values(statsGroups))
  const selectedDev = devs.find(d => d.id === executor) ?? null

  if (id === null || card === null) return null
  const sla = liveSla(card, state.now)

  const submit = async () => {
    if (team === null || busy) return
    setBusy(true)
    const ok = await doAssign(card, team, executor)
    setBusy(false)
    if (ok) dispatch({ type: 'OPEN_ASSIGN', id: null })
  }

  return (
    <Modal
      title="Назначить команду"
      subtitle={`${card.id} · ${card.header ?? ''} · ${sla.label}`}
      onClose={() => dispatch({ type: 'OPEN_ASSIGN', id: null })}
      width={880}
      footer={
        <>
          <span className="modal__info" style={{ marginRight: 'auto', marginBottom: 0 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5M12 8v.1" />
            </svg>
            Исполнителю и команде придёт уведомление в браузер, Telegram и мобильное приложение
          </span>
          <Button variant="secondary" onClick={() => dispatch({ type: 'OPEN_ASSIGN', id: null })}>
            Отмена
          </Button>
          <Button variant="primary" disabled={team === null || busy} onClick={() => void submit()}>
            Назначить{team !== null ? ` ${team}` : ''}
            {selectedDev !== null ? ` · ${shortName(selectedDev.name)}` : ''}
          </Button>
        </>
      }
    >
      <p style={{ fontWeight: 800, fontSize: 16, marginBottom: 12 }}>1. Команда</p>
      {!aiEnabled && (
        <p className="assignnote assignnote--error">
          <SparkIcon size={14} />
          BigDad не подключён — ИИ-рекомендация недоступна, команду можно выбрать вручную
        </p>
      )}
      {aiBusy && (
        <p className="assignnote assignnote--busy">
          <SparkIcon size={14} />
          BigDad подбирает команду — анализирует нагрузку, опыт и похожие инциденты, это до минуты
        </p>
      )}
      {recommended !== null && (
        <div className="assignnote">
          <p>
            <SparkIcon size={14} />
            Рекомендует BigDad: <b>{recommended.group}</b>
            {recommended.confidence !== null ? ` · уверенность ${recommended.confidence}%` : ''}
            {recommended.reason !== null ? ` — ${recommended.reason}` : ''}
          </p>
          {recommended.alternatives.length > 0 && (
            <div className="assignnote__alts">
              <span>Запасные:</span>
              {recommended.alternatives.map(alt => (
                <button key={alt.group} type="button" className="assignnote__alt" title={alt.reason} onClick={() => setTeam(alt.group)}>
                  {alt.group}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {aiError !== null && (
        <p className="assignnote assignnote--error">
          <SparkIcon size={14} />
          {aiError}. Команду можно выбрать без рекомендации
        </p>
      )}
      <div className="teamcards">
        {teams.map(name => {
          const load = statsGroups[name] ?? 0
          const loadPct = Math.round((load / maxLoad) * 100)
          return (
            <div
              key={name}
              className={`teamcard ${team === name ? 'teamcard--selected' : ''}`}
              onClick={() => setTeam(name)}
            >
              <div className="teamcard__head">
                <span className="teamcard__name">{name}</span>
                {team === name ? (
                  <span className="teamcard__check">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m5 12.5 4.5 4.5L19 7.5" />
                    </svg>
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-3)' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.6" />
                      <circle cx="12" cy="12" r="1.6" />
                      <circle cx="19" cy="12" r="1.6" />
                    </svg>
                  </span>
                )}
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>{devs.length} разработчиков в штате</p>
              <div className="teamcard__people" style={{ marginTop: 10 }}>
                <span className="avatar-stack">
                  {devs.slice(0, 3).map(d => (
                    <Avatar key={d.id} size="sm" tone="blue" name={d.name} />
                  ))}
                </span>
              </div>
              <div className="loadrow" style={{ marginTop: 10 }}>
                <span>Загрузка</span>
                <span>
                  <b>{loadPct}%</b> · {load} инцидент{load === 1 ? '' : load < 5 ? 'а' : 'ов'}
                </span>
              </div>
              <div className="loadbar">
                <span className="loadbar__fill loadbar__fill--orange" style={{ width: `${loadPct}%` }} />
              </div>
            </div>
          )
        })}
        {teams.length === 0 && (
          <p style={{ color: 'var(--text-2)' }}>В данных нет назначенных команд — назначьте команду в ITSM или выберите позже</p>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <p style={{ fontWeight: 800, fontSize: 16 }}>2. Исполнитель</p>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>сортировка по загрузке</span>
      </div>
      {devs
        .slice()
        .sort((a, b) => a.load - b.load)
        .map(dev => (
          <div
            key={dev.id}
            className={`executor ${executor === dev.id ? 'executor--selected' : ''}`}
            onClick={() => setExecutor(executor === dev.id ? null : dev.id)}
          >
            <Avatar tone="blue" name={dev.name} />
            <div>
              <p className="executor__name">{dev.name}</p>
              <p className="executor__role">developer · {dev.login !== '' ? dev.login : 'itsm'}</p>
            </div>
            <div className="executor__load">
              <div className="loadrow">
                <span>Загрузка</span>
                <span>{Math.min(100, dev.load * 20)}%</span>
              </div>
              <div className="loadbar">
                <span className="loadbar__fill loadbar__fill--blue" style={{ width: `${Math.min(100, dev.load * 20)}%` }} />
              </div>
            </div>
            <div className="executor__stat">
              <b>{dev.done} решено</b>
              <span style={{ color: 'var(--text-2)' }}>активных: {dev.load}</span>
            </div>
          </div>
        ))}
      {devs.length === 0 && <p style={{ color: 'var(--text-2)' }}>Разработчиков пока нет — создайте их в разделе «Пользователи»</p>}
    </Modal>
  )
}

export function FreezeModal() {
  const { state, dispatch, doFreeze } = useApp()
  const id = state.freezeId
  const card = id !== null ? state.cards.get(id) ?? null : null
  const [reason, setReason] = useState('Ждём ответа подрядчика')
  const [autoAt, setAutoAt] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  if (id === null || card === null) return null

  const submit = () => {
    if (busy) return
    setBusy(true)
    const body: FreezeRequest = { reason }
    if (text.trim() !== '') body.comment = text.trim()
    if (autoAt !== '') {
      const at = new Date(autoAt)
      if (!Number.isNaN(at.getTime())) body.autoUnfreezeAt = at.toISOString()
    }
    void (async () => {
      const ok = await doFreeze(card.id, body)
      setBusy(false)
      if (ok) dispatch({ type: 'OPEN_FREEZE', id: null })
    })()
  }

  return (
    <Modal
      title={<>Заморозить {card.id}?</>}
      subtitle="SLA-таймер встанет на паузу, карточка останется в колонке со значком снежинки"
      onClose={() => dispatch({ type: 'OPEN_FREEZE', id: null })}
      width={560}
      footer={
        <>
          <span className="spacer" />
          <Button variant="secondary" onClick={() => dispatch({ type: 'OPEN_FREEZE', id: null })}>
            Отмена
          </Button>
          <Button variant="freeze" disabled={busy} onClick={submit}>
            <SnowflakeIcon size={15} />
            Заморозить
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 18 }}>
        <span className="resulticon resulticon--blue" style={{ width: 52, height: 52, margin: 0 }}>
          <SnowflakeIcon size={24} />
        </span>
        <SlaChip card={card} now={state.now} />
      </div>
      <label className="field">
        <span className="field__label">Причина</span>
        <Select
          value={reason}
          options={stringOptions(['Ждём ответа подрядчика', 'Плановые работы на стороне клиента', 'Недостаточно данных от заявителя', 'Другое'])}
          onChange={setReason}
        />
      </label>
      <label className="field">
        <span className="field__label">Разморозить автоматически</span>
        <input className="input" type="datetime-local" value={autoAt} onChange={e => setAutoAt(e.target.value)} />
        <span className="field__hint">Можно разморозить вручную в любой момент</span>
      </label>
      <label className="field">
        <span className="field__label">Комментарий</span>
        <Textarea value={text} placeholder="Проблема на стороне CDN-партнёра, тикет #88412…" onChange={e => setText(e.target.value)} />
        <span className="field__hint">Увидят координаторы и команда</span>
      </label>
    </Modal>
  )
}
