import { useEffect, useMemo, useState } from 'react'
import * as api from '../api'
import { formatShort, liveSla, relativeTime, shortName, slaBigValue } from '../format'
import { useApp } from '../store'
import type { Card, IncidentDetail } from '../types'
import { ASSIGNED, CLOSED, IN_PROGRESS, RESOLVED, RESEARCH } from '../types'
import {
  Avatar,
  Button,
  CheckCircleIcon,
  CheckIcon,
  CommentIcon,
  EmptyState,
  Field,
  FileIcon,
  Input,
  LinkIcon,
  Modal,
  RefreshIcon,
  SendIcon,
  SeverityBadge,
  SlaChip,
  SparkIcon,
  StatusPill,
  Tabs,
  Textarea,
  TrashIcon,
  UndoIcon,
  UploadIcon,
} from '../ui'

function IncidentDetailBox({ detail, card, actions }: { detail: IncidentDetail | null; card: Card; actions?: React.ReactNode }) {
  const { state, dispatch } = useApp()
  const sla = liveSla(card, state.now)
  const meta = (detail?.data ?? {}) as Record<string, unknown>
  const description = typeof meta.description === 'string' && meta.description !== '' ? meta.description : (card.shortDescription ?? '—')
  const solution = typeof meta.solution === 'string' && meta.solution !== '' ? meta.solution : null
  const ai = detail?.ai ?? null
  return (
    <div className="detailcard">
      <div className="panel__top">
        <span className="panel__id">{card.id}</span>
        <SeverityBadge priorityId={card.priorityId} />
        <StatusPill stateId={card.stateId} />
        <span className="panel__topspacer" />
        <a className="iconbtn" href={card.itsmUrl} target="_blank" rel="noreferrer" title="Открыть в ITSM">
          <LinkIcon size={16} />
        </a>
        <button type="button" className="iconbtn" aria-label="Закрыть" onClick={() => dispatch({ type: 'OPEN_PANEL', id: null })}>
          ✕
        </button>
      </div>
      <h2 style={{ fontSize: 24, fontWeight: 800, margin: '22px 0 18px' }}>{card.header ?? 'Без названия'}</h2>
      <div className="slabox">
        <span className="slabox__icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        </span>
        <div>
          <p className="slabox__label">{sla.state === 'breach' ? 'Просрочен' : sla.state === 'resolved' ? 'Решён' : 'До дедлайна'}</p>
          <p className={`slabox__time ${sla.state === 'breach' ? 'slabox__time--red' : ''}`}>{slaBigValue(card, state.now)}</p>
        </div>
        <div className="slabox__right">
          <b>SLA {card.sla.totalSeconds === undefined || card.sla.totalSeconds === null || !Number.isFinite(card.sla.totalSeconds) ? '—' : `${Math.round((card.sla.totalSeconds / 3600) * 2) / 2} ч`}</b>
          дедлайн {formatShort(card.deadline)}
        </div>
      </div>
      <div className="pgrid" style={{ marginTop: 22 }}>
        <div>
          <p className="pgrid__label">Продукт</p>
          <p className="pgrid__value">{card.productName ?? '—'}</p>
        </div>
        <div>
          <p className="pgrid__label">Координатор</p>
          <p className="pgrid__value">
            <Avatar size="sm" tone="ghost" />
            {card.acknowledged?.name ?? '—'}
          </p>
        </div>
        <div>
          <p className="pgrid__label">Команда</p>
          <p className="pgrid__value">{card.assignedGroupName ?? '—'}</p>
        </div>
        <div>
          <p className="pgrid__label">Исполнитель</p>
          <p className="pgrid__value">{card.assignedEmployee ?? '—'}</p>
        </div>
      </div>
      <p className="psection">Описание</p>
      <p className="psection__text">{description}</p>
      {solution !== null && (
        <>
          <p className="psection">Отчёт исполнителя</p>
          <p className="psection__text">{solution}</p>
        </>
      )}
      {ai !== null && (ai.summary !== null || ai.riskScore !== null) && (
        <div className="bigdad">
          <div className="bigdad__head">
            <span className="bigdad__icon">
              <SparkIcon size={17} />
            </span>
            <div>
              <p className="bigdad__title">BigDad · ИИ-ассистент</p>
              <p className="bigdad__sub">обновлено {relativeTime(card.updatedAt, state.now)}</p>
            </div>
            <span className="bigdad__refresh">
              <RefreshIcon size={14} />
            </span>
          </div>
          {ai.summary !== null && <p className="bigdad__text">{ai.summary}</p>}
          {ai.riskScore !== null && (
            <>
              <div className="bigdad__risk">
                <span>Риск эскалации</span>
                <b>{ai.riskScore} / 100</b>
              </div>
              <div className="riskbar">
                <span className="riskbar__fill" style={{ width: `${Math.min(100, ai.riskScore)}%` }} />
              </div>
            </>
          )}
        </div>
      )}
      {actions !== undefined && <div style={{ display: 'flex', gap: 12, marginTop: 24, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  )
}

function MyCard({ card, selected, onSelect }: { card: Card; selected: boolean; onSelect: () => void }) {
  const { state } = useApp()
  const frozen = state.freeze[card.id] !== undefined
  return (
    <div className="acard" style={{ borderColor: selected ? 'var(--blue)' : undefined, borderLeftWidth: 4 }} onClick={onSelect}>
      <div className="acard__top">
        <span className="acard__id">{card.id}</span>
        <SeverityBadge priorityId={card.priorityId} />
      </div>
      <p className="acard__title">{card.header ?? 'Без названия'}</p>
      <p className="acard__line">{card.assignedEmployee ?? '—'}</p>
      <div style={{ marginTop: 8 }}>
        <SlaChip card={card} now={state.now} frozen={frozen} />
      </div>
    </div>
  )
}

// ---------------- разработчик ----------------

export function DevPage() {
  const { state, showToast } = useApp()
  const [items, setItems] = useState<Card[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'active' | 'review' | 'closed'>('active')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<IncidentDetail | null>(null)
  const [reportOpen, setReportOpen] = useState(false)
  const [sentOpen, setSentOpen] = useState(false)
  const [sentCard, setSentCard] = useState<Card | null>(null)

  const reload = async () => {
    setLoading(true)
    try {
      const res = await api.fetchMyIncidents(true)
      const all = res.levels.flatMap(l => l.items)
      setItems(all)
      setSelectedId(prev => prev ?? all.find(c => c.isActive && c.stateId !== RESOLVED)?.id ?? all[0]?.id ?? null)
    } catch (err) {
      console.error('Не удалось загрузить мои инциденты', err)
      showToast('Не удалось загрузить мои инциденты', 'warning')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const d = await api.fetchIncident(selectedId)
        if (!cancelled) setDetail(d)
      } catch (err) {
        console.error('Не удалось загрузить инцидент', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedId])

  const filtered = useMemo(() => {
    if (tab === 'active') return items.filter(c => c.isActive && c.stateId !== RESOLVED)
    if (tab === 'review') return items.filter(c => c.stateId === RESOLVED)
    return items.filter(c => c.stateId === CLOSED)
  }, [items, tab])

  const selected = selectedId !== null ? state.cards.get(selectedId) ?? items.find(c => c.id === selectedId) ?? null : null

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Мои инциденты</h1>
          <p className="pagehead__sub">
            {state.user?.fullName ?? ''} · видны только инциденты, где вы исполнитель или участник
          </p>
        </div>
      </div>

      <div className="split">
        <div>
          <Tabs
            tabs={[
              { key: 'active', label: `Активные · ${items.filter(c => c.isActive && c.stateId !== RESOLVED).length}` },
              { key: 'review', label: 'На проверке' },
              { key: 'closed', label: 'Закрытые' },
            ]}
            value={tab}
            onChange={setTab}
          />
          <p className="listlabel">{tab === 'active' ? 'Назначены мне' : tab === 'review' ? 'Ждут проверки' : 'Завершены'} · {filtered.length}</p>
          {loading ? (
            <p style={{ color: 'var(--text-2)' }}>Загрузка…</p>
          ) : filtered.length === 0 ? (
            <EmptyState title="Инцидентов нет" note="Новые назначения появятся здесь и придут уведомлением" />
          ) : (
            filtered.map(card => <MyCard key={card.id} card={card} selected={card.id === selectedId} onSelect={() => setSelectedId(card.id)} />)
          )}
        </div>
        <div>
          {selected !== null ? (
            <IncidentDetailBox
              detail={detail}
              card={selected}
              actions={
                selected.stateId === IN_PROGRESS || selected.stateId === ASSIGNED || selected.stateId === RESEARCH ? (
                  <>
                    <Button variant="primary" onClick={() => setReportOpen(true)}>
                      <CheckCircleIcon size={15} />
                      Отметить исправленным
                    </Button>
                    <Button variant="secondary">
                      <CommentIcon size={15} />
                      Комментарий
                    </Button>
                  </>
                ) : selected.stateId === RESOLVED ? (
                  <p style={{ color: 'var(--text-2)', fontSize: 13 }}>Инцидент отправлен на проверку — тестировщик подтвердит исправление</p>
                ) : null
              }
            />
          ) : (
            <EmptyState title="Выберите инцидент" />
          )}
        </div>
      </div>

      {reportOpen && selected !== null && (
        <ReportModal
          card={selected}
          onClose={() => setReportOpen(false)}
          onSent={() => {
            setReportOpen(false)
            setSentCard(selected)
            setSentOpen(true)
            void reload()
          }}
        />
      )}
      {sentOpen && sentCard !== null && (
        <Modal
          title="Отправлено на проверку"
          onClose={() => setSentOpen(false)}
          width={560}
          footer={
            <>
              <span className="spacer" />
              <Button variant="primary" style={{ width: '100%' }} onClick={() => setSentOpen(false)}>
                Понятно
              </Button>
            </>
          }
        >
          <div className="modal--center" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span className="resulticon resulticon--green">
              <CheckCircleIcon size={34} />
            </span>
            <p style={{ textAlign: 'left', color: 'var(--text-2)', fontSize: 15, lineHeight: 1.55 }}>
              {sentCard.id} перешёл в статус «На проверке». Тестировщик получил уведомление. SLA-таймер продолжает идти до закрытия.
            </p>
          </div>
        </Modal>
      )}
    </>
  )
}

const REASONS = ['Медленный запрос к БД', 'Ошибка в конфигурации', 'Деградация внешнего сервиса', 'Регресс после релиза', 'Недостаток ресурсов', 'Другое']

function ReportModal({ card, onClose, onSent }: { card: Card; onClose: () => void; onSent: () => void }) {
  const { doTransition, showToast } = useApp()
  const [text, setText] = useState('')
  const [reason, setReason] = useState(REASONS[0])
  const [mrLink, setMrLink] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (text.trim().length < 20) {
      showToast('Опишите, что сделано — минимум 20 символов', 'warning')
      return
    }
    setBusy(true)
    const commentText = files.length > 0 ? `${mrLink !== '' ? `${mrLink}\n` : ''}Файлы: ${files.join(', ')}` : mrLink
    const ok = await doTransition(card, RESOLVED, {
      solution: text.trim(),
      stateReason: reason,
      comment: commentText !== '' ? commentText : undefined,
    })
    setBusy(false)
    if (ok) onSent()
  }

  return (
    <Modal
      title="Отчёт об исправлении"
      subtitle={`${card.id} · ${card.header ?? ''} — после отправки инцидент перейдёт «На проверке»`}
      onClose={onClose}
      width={880}
      footer={
        <>
          <span className="spacer" />
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            <SendIcon size={15} />
            Отправить на проверку
          </Button>
        </>
      }
    >
      <Field label="Что сделано" hint={`Минимум 20 символов · ${text.length}/2000`}>
        <Textarea
          maxLength={2000}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Добавил индекс по (account_id, period) в таблицу начислений и кэш детализации на 5 минут. Время ответа — 0,8 с."
        />
      </Field>
      <div className="formrow">
        <Field label="Причина">
          <select className="input" value={reason} onChange={e => setReason(e.target.value)}>
            {REASONS.map(r => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
        <Field label="Ссылка на МР" hint="Необязательно">
          <Input value={mrLink} onChange={e => setMrLink(e.target.value)} placeholder="gitlab.mts.ru/billing/api/-/merge_requests/1842" />
        </Field>
      </div>
      <Field label="Файлы">
        <div className="dropzone">
          <span className="dropzone__icon">
            <UploadIcon size={22} />
          </span>
          <p>
            <b>Перетащите файлы сюда или выберите на компьютере</b>
          </p>
          <p style={{ fontSize: 12, marginTop: 4 }}>PDF, DOCX, LOG, PNG · до 20 МБ</p>
        </div>
        {files.map(name => (
          <div key={name} className="filechip">
            <FileIcon size={16} />
            <div>
              <p className="filechip__name">{name}</p>
              <p className="filechip__meta">загружено</p>
            </div>
            <button type="button" className="iconbtn filechip__del" onClick={() => setFiles(prev => prev.filter(x => x !== name))} aria-label="Удалить">
              <TrashIcon size={15} />
            </button>
          </div>
        ))}
      </Field>
    </Modal>
  )
}

// ---------------- тестировщик ----------------

const CHECKS = ['Проблема не воспроизводится', 'Проверено на затронутых сценариях', 'Нет новых ошибок в логах за 30 минут']

export function QaPage() {
  const { state, doTransition, showToast } = useApp()
  const [items, setItems] = useState<Card[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'review' | 'done' | 'returned'>('review')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<IncidentDetail | null>(null)
  const [checks, setChecks] = useState<boolean[]>([false, false, false])
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectCard, setRejectCard] = useState<Card | null>(null)

  const reload = async () => {
    setLoading(true)
    try {
      const res = await api.fetchIncidents({ stateId: [RESOLVED, CLOSED, IN_PROGRESS], perPage: 200, sort: 'attention' })
      setItems(res.items)
      setSelectedId(prev => prev ?? res.items.find(c => c.stateId === RESOLVED)?.id ?? null)
    } catch (err) {
      console.error('Не удалось загрузить инциденты на проверку', err)
      showToast('Не удалось загрузить инциденты на проверку', 'warning')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const d = await api.fetchIncident(selectedId)
        if (!cancelled) setDetail(d)
      } catch (err) {
        console.error('Не удалось загрузить инцидент', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedId])

  const filtered = useMemo(() => {
    if (tab === 'review') return items.filter(c => c.stateId === RESOLVED)
    if (tab === 'done') return items.filter(c => c.stateId === CLOSED)
    return items.filter(c => c.stateId === IN_PROGRESS)
  }, [items, tab])

  const selected = selectedId !== null ? state.cards.get(selectedId) ?? items.find(c => c.id === selectedId) ?? null : null

  const approve = async () => {
    if (selected === null) return
    const passed = CHECKS.filter((_, i) => checks[i])
    const ok = await doTransition(selected, CLOSED, {
      comment: passed.length === CHECKS.length ? 'Проверка пройдена по всем пунктам' : `Проверка пройдена: ${passed.join('; ')}`,
    })
    if (ok) {
      showToast(`${selected.id} закрыт — проверка пройдена`, 'success')
      void reload()
    }
  }

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Проверка исправлений</h1>
          <p className="pagehead__sub">{state.user?.fullName ?? ''} · тестировщик</p>
        </div>
      </div>

      <div className="split">
        <div>
          <Tabs
            tabs={[
              { key: 'review', label: `На проверке · ${items.filter(c => c.stateId === RESOLVED).length}` },
              { key: 'done', label: 'Проверено' },
              { key: 'returned', label: 'Возвращено' },
            ]}
            value={tab}
            onChange={setTab}
          />
          <p className="listlabel">{tab === 'review' ? 'Ждут проверки' : tab === 'done' ? 'Закрыты' : 'Вернулись в работу'} · {filtered.length}</p>
          {loading ? (
            <p style={{ color: 'var(--text-2)' }}>Загрузка…</p>
          ) : filtered.length === 0 ? (
            <EmptyState title="Инцидентов нет" note={tab === 'review' ? 'Новые отчёты разработчиков появятся здесь' : undefined} />
          ) : (
            filtered.map(card => <MyCard key={card.id} card={card} selected={card.id === selectedId} onSelect={() => setSelectedId(card.id)} />)
          )}
        </div>
        <div>
          {selected !== null ? (
            <IncidentDetailBox
              detail={detail}
              card={selected}
              actions={
                selected.stateId === RESOLVED ? (
                  <>
                    <div style={{ width: '100%' }}>
                      <p className="psection" style={{ marginTop: 0 }}>Проверка</p>
                      <div className="checklist">
                        {CHECKS.map((check, index) => (
                          <span
                            key={check}
                            className="checkrow"
                            onClick={() => setChecks(prev => prev.map((v, i) => (i === index ? !v : v)))}
                          >
                            <span className={`checkbox ${checks[index] ? 'checkbox--on' : ''}`}>
                              {checks[index] && <CheckIcon size={13} />}
                            </span>
                            {check}
                          </span>
                        ))}
                      </div>
                    </div>
                    <Button variant="primary" onClick={() => void approve()}>
                      <CheckIcon size={15} />
                      Проверка пройдена
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setRejectCard(selected)
                        setRejectOpen(true)
                      }}
                    >
                      <UndoIcon size={15} />
                      Вернуть в работу
                    </Button>
                  </>
                ) : null
              }
            />
          ) : (
            <EmptyState title="Выберите инцидент" />
          )}
        </div>
      </div>

      {rejectOpen && rejectCard !== null && (
        <RejectModal
          card={rejectCard}
          onClose={() => setRejectOpen(false)}
          onReturned={() => {
            setRejectOpen(false)
            void reload()
          }}
          doTransition={doTransition}
        />
      )}
    </>
  )
}

function RejectModal({
  card,
  onClose,
  onReturned,
  doTransition,
}: {
  card: Card
  onClose: () => void
  onReturned: () => void
  doTransition: ReturnType<typeof useApp>['doTransition']
}) {
  const [reason, setReason] = useState('Исправление не воспроизводится')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    const ok = await doTransition(card, IN_PROGRESS, {
      stateReason: reason,
      comment: text.trim() !== '' ? text.trim() : undefined,
    })
    setBusy(false)
    if (ok) {
      onReturned()
    }
  }

  return (
    <Modal
      title={<>Вернуть {card.id} в работу?</>}
      subtitle="Разработчик получит уведомление, статус сменится на «В работе»"
      onClose={onClose}
      width={560}
      footer={
        <>
          <span className="spacer" />
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            <UndoIcon size={15} />
            Вернуть в работу
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 18 }}>
        <span className="resulticon resulticon--yellow" style={{ width: 52, height: 52, margin: 0 }}>
          <UndoIcon size={24} />
        </span>
        <div>
          <p style={{ fontWeight: 700 }}>{shortName(card.assignedEmployee ?? '')}</p>
          <p style={{ fontSize: 13, color: 'var(--text-2)' }}>исполнитель инцидента</p>
        </div>
      </div>
      <Field label="Что не так">
        <select className="input" value={reason} onChange={e => setReason(e.target.value)}>
          <option>Исправление не воспроизводится</option>
          <option>Проверка на затронутых сценариях не пройдена</option>
          <option>Появились новые ошибки в логах</option>
          <option>Другое</option>
        </select>
      </Field>
      <Field label="Комментарий для разработчика">
        <Textarea value={text} placeholder="На «Семейном» всё ещё 6–8 с" onChange={e => setText(e.target.value)} />
      </Field>
    </Modal>
  )
}
