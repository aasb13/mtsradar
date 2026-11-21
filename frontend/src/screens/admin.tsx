import { useEffect, useMemo, useState } from 'react'
import * as api from '../api'
import { formatDurationWords, formatShort, priorityMeta, relativeTime } from '../format'
import { useApp } from '../store'
import type { Card, Role, User } from '../types'
import { PRIORITY_SLA_HOURS, PRIORITIES } from '../types'
import { FilterChipMenu, KpiRow, SLA_LABELS } from './kanban'
import {
  Avatar,
  BoxIcon,
  Button,
  DownloadIcon,
  EmptyState,
  Field,
  FileIcon,
  Input,
  MailIcon,
  Modal,
  PlusIcon,
  SeverityBadge,
  SlaChip,
  StatusPill,
  Textarea,
  TrashIcon,
  UploadIcon,
  UserIcon,
} from '../ui'

const LOCAL_PRODUCTS_KEY = 'radar-local-products'
const LOCAL_TEAMS_KEY = 'radar-local-teams'

function localList(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? [] : (JSON.parse(raw) as string[])
  } catch {
    return []
  }
}

function saveLocalList(key: string, values: string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(values))
  } catch (err) {
    console.error('Не удалось сохранить список', err)
  }
}

const ROLE_LABELS: Record<Role, string> = {
  admin: 'Администратор',
  coordinator: 'Координатор',
  developer: 'Разработчик',
  viewer: 'Тестировщик',
}

const ROLE_OPTIONS: { key: Role; label: string }[] = [
  { key: 'coordinator', label: 'Координатор' },
  { key: 'developer', label: 'Разработчик' },
  { key: 'viewer', label: 'Тестировщик' },
  { key: 'admin', label: 'Администратор' },
]

// ---------------- реестр инцидентов ----------------

type StatusTab = 'open' | 'all' | 'closed'

export function AdminIncidentsPage() {
  const { state, dispatch, showToast } = useApp()
  const [items, setItems] = useState<Card[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [statusTab, setStatusTab] = useState<StatusTab>('open')
  const [createOpen, setCreateOpen] = useState(false)

  const reload = async () => {
    setLoading(true)
    try {
      const res = await api.fetchIncidents({
        active: statusTab === 'open' ? true : undefined,
        stateId: statusTab === 'closed' ? [10] : undefined,
        priorityId: state.filters.priorityId !== null ? [state.filters.priorityId] : undefined,
        productName: state.filters.product ?? undefined,
        assignedGroupName: state.filters.team ?? undefined,
        slaState: state.filters.sla !== null ? [state.filters.sla] : undefined,
        q: state.search,
        perPage: 200,
        sort: 'submitDate',
        order: 'desc',
      })
      setItems(res.items)
      setTotal(res.total)
    } catch (err) {
      console.error('Не удалось загрузить инциденты', err)
      showToast('Не удалось загрузить инциденты', 'warning')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusTab, state.filters.priorityId, state.filters.product, state.filters.team, state.filters.sla, state.search])

  const resolvedToday = useMemo(
    () => items.filter(c => c.completionDate !== null && Date.parse(c.completionDate) >= new Date(new Date().setHours(0, 0, 0, 0)).getTime()).length,
    [items],
  )
  const openCount = state.kpi?.active ?? 0

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Инциденты</h1>
          <p className="pagehead__sub">Все инциденты · {openCount} открытых, {resolvedToday} завершено сегодня</p>
        </div>
        <div className="pagehead__actions">
          <a className="btn btn--secondary" href={api.exportUrl()} download>
            <DownloadIcon size={15} />
            Экспорт
          </a>
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <PlusIcon size={15} />
            Создать инцидент
          </Button>
        </div>
      </div>

      <KpiRow />

      <div className="toolrow">
        <div className="fchips">
          <span className={`fchip ${statusTab !== 'all' ? 'fchip--active' : ''}`} style={{ cursor: 'default' }}>
            <span className="fchip__label">Статус</span>
            <span className="fchip__value">{statusTab === 'open' ? 'Открытые' : statusTab === 'closed' ? 'Закрытые' : 'Все'}</span>
            <StatusTabsMenu value={statusTab} onChange={setStatusTab} />
          </span>
          <FilterChipMenu
            label="Приоритет"
            value={state.filters.priorityId === null ? 'Все' : priorityMeta(state.filters.priorityId).label}
            options={[
              { key: null, label: 'Все' },
              { key: 4, label: 'Критический' },
              { key: 3, label: 'Высокий' },
              { key: 2, label: 'Средний' },
              { key: 1, label: 'Низкий' },
            ]}
            onSelect={key => dispatch({ type: 'SET_FILTERS', patch: { priorityId: key as number | null } })}
          />
          <FilterChipMenu
            label="Продукт"
            value={state.filters.product ?? 'Все'}
            options={[{ key: null, label: 'Все' }, ...(state.dictionaries?.products ?? []).map(p => ({ key: p, label: p }))]}
            onSelect={key => dispatch({ type: 'SET_FILTERS', patch: { product: key as string | null } })}
          />
          <FilterChipMenu
            label="Команда"
            value={state.filters.team ?? 'Все'}
            options={[{ key: null, label: 'Все' }, ...(state.dictionaries?.assignedGroups ?? []).map(t => ({ key: t, label: t }))]}
            onSelect={key => dispatch({ type: 'SET_FILTERS', patch: { team: key as string | null } })}
          />
          <FilterChipMenu
            label="SLA"
            value={state.filters.sla === null ? 'Все' : SLA_LABELS[state.filters.sla] ?? state.filters.sla}
            options={[
              { key: null, label: 'Все' },
              { key: 'ok', label: SLA_LABELS.ok },
              { key: 'warning', label: SLA_LABELS.warning },
              { key: 'danger', label: SLA_LABELS.danger },
              { key: 'breached', label: SLA_LABELS.breached },
            ]}
            onSelect={key => dispatch({ type: 'SET_FILTERS', patch: { sla: key as string | null } })}
          />
        </div>
        <span style={{ color: 'var(--text-3)', fontSize: 13 }}>Показано {items.length} из {total}</span>
      </div>

      {loading ? (
        <p style={{ color: 'var(--text-2)', padding: 24 }}>Загрузка…</p>
      ) : items.length === 0 ? (
        <EmptyState title="Инцидентов нет" note="Все задачи обработаны или ещё не поступили" />
      ) : (
        <div className="tablecard">
          <table className="table">
            <thead>
              <tr>
                <th>№</th>
                <th>Название</th>
                <th>Продукт</th>
                <th>Приоритет</th>
                <th>Статус</th>
                <th>Команда</th>
                <th>SLA</th>
                <th>Создан</th>
              </tr>
            </thead>
            <tbody>
              {items.map(card => (
                <tr
                  key={card.id}
                  className={`rowlink ${card.isCritical && card.isActive ? 'critrow' : ''}`}
                  onClick={() => dispatch({ type: 'OPEN_PANEL', id: card.id })}
                >
                  <td className="table__id">{card.id}</td>
                  <td className="table__title" style={{ maxWidth: 240 }}>{card.header ?? '—'}</td>
                  <td className="table__muted">{card.productName ?? '—'}</td>
                  <td>
                    <SeverityBadge priorityId={card.priorityId} />
                  </td>
                  <td>
                    <StatusPill stateId={card.stateId} />
                  </td>
                  <td>{card.assignedGroupName ?? '—'}</td>
                  <td>
                    <SlaChip card={card} now={state.now} frozen={state.freeze[card.id] !== undefined} />
                  </td>
                  <td className="table__muted">{formatShort(card.submitDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && <CreateIncidentModal onClose={() => setCreateOpen(false)} onCreated={() => void reload()} />}
    </>
  )
}

function StatusTabsMenu({ value, onChange }: { value: StatusTab; onChange: (v: StatusTab) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'inherit' }} onClick={e => { e.stopPropagation(); setOpen(!open) }}>
        <path d="m6 9 6 6 6-6" />
      </svg>
      {open && (
        <span className="fchip-menu" onClick={e => e.stopPropagation()}>
          {([['open', 'Открытые'], ['all', 'Все'], ['closed', 'Закрытые']] as [StatusTab, string][]).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={value === key ? 'fchip-menu__sel' : ''}
              onClick={() => {
                setOpen(false)
                onChange(key)
              }}
            >
              {label}
            </button>
          ))}
        </span>
      )}
    </>
  )
}

// ---------------- создание инцидента ----------------

function CreateIncidentModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { state, showToast } = useApp()
  const [header, setHeader] = useState('')
  const [product, setProduct] = useState('')
  const [description, setDescription] = useState('')
  const [priorityId, setPriorityId] = useState(3)
  const [files, setFiles] = useState<{ name: string; size: string }[]>([])
  const [busy, setBusy] = useState(false)

  const products = [...(state.dictionaries?.products ?? []), ...localList(LOCAL_PRODUCTS_KEY)]
  useEffect(() => {
    if (product === '' && products.length > 0) setProduct(products[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products.length])

  const submit = async () => {
    if (header.trim().length < 3 || busy) {
      showToast('Название — минимум 3 символа', 'warning')
      return
    }
    if (description.trim().length < 20) {
      showToast('Описание — минимум 20 символов', 'warning')
      return
    }
    setBusy(true)
    try {
      const nowIso = new Date().toISOString()
      const deadline = new Date(Date.now() + PRIORITY_SLA_HOURS[priorityId] * 3600000).toISOString()
      const record = {
        id: `INC${Math.floor(100000 + Math.random() * 900000)}`,
        stateId: 0,
        state: 'Назначен',
        stateEnum: 'Assigned',
        submitDate: nowIso,
        deadline,
        header: header.trim(),
        description: description.trim(),
        shortDescription: description.trim().slice(0, 120),
        priorityId,
        priority: PRIORITIES[priorityId] ?? 'Средний',
        productName: product !== '' ? product : null,
        initiatorName: state.user?.fullName ?? null,
        receivingChannel: 'Радар',
        solution: null,
      }
      const body = new FormData()
      body.append('file', new Blob([JSON.stringify([record])], { type: 'application/json' }), 'new-incident.json')
      const token = api.getAccessToken()
      const res = await fetch('/api/import?mode=upsert', {
        method: 'POST',
        headers: token !== null ? { Authorization: `Bearer ${token}` } : undefined,
        body,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        throw new Error(err?.detail ?? `HTTP ${res.status}`)
      }
      const report = (await res.json()) as { createdIds?: string[]; created?: number }
      const createdId = Array.isArray(report.createdIds) && report.createdIds.length > 0 ? report.createdIds[0] : record.id
      showToast(`Инцидент ${createdId} создан — координаторы и команда получат уведомление`, 'success')
      onCreated()
      onClose()
    } catch (err) {
      console.error('Не удалось создать инцидент', err)
      showToast(err instanceof Error ? err.message : 'Не удалось создать инцидент', 'critical')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Новый инцидент"
      subtitle="Координатор и команда получат уведомление сразу после создания"
      onClose={onClose}
      width={880}
      footer={
        <>
          <span className="spacer" />
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            <PlusIcon size={15} />
            Создать инцидент
          </Button>
        </>
      }
    >
      <div className="formrow">
        <Field label="Название" hint="Коротко: что сломалось">
          <Input value={header} onChange={e => setHeader(e.target.value)} placeholder="Не приходят SMS-уведомления" />
        </Field>
        <Field label="Продукт">
          <select className="input" value={product} onChange={e => setProduct(e.target.value)}>
            {products.map(p => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            {products.length === 0 && <option value="">—</option>}
          </select>
        </Field>
      </div>
      <Field label="Описание" hint={`Минимум 20 символов · ${description.length}/2000`}>
        <Textarea
          maxLength={2000}
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="С 02:40 абоненты не получают SMS с кодами подтверждения. Затронуты вход в Мой МТС и оплата. Жалоб в поддержку — 312 за час."
        />
      </Field>
      <Field label="Приоритет">
        <div className="sevswitch">
          {[4, 3, 2, 1].map(p => (
            <button
              key={p}
              type="button"
              className={`sevswitch__opt ${priorityId === p ? 'sevswitch__opt--active' : ''}`}
              onClick={() => setPriorityId(p)}
            >
              <span
                className="sevdot"
                style={{ background: p === 4 ? 'var(--red)' : p === 3 ? 'var(--orange)' : p === 2 ? 'var(--yellow)' : 'var(--gray)' }}
              />
              {priorityMeta(p).label}
            </button>
          ))}
        </div>
      </Field>
      <p className="modal__info">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        на решение: {PRIORITY_SLA_HOURS[priorityId]} часов
      </p>
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
        {files.map(f => (
          <div key={f.name} className="filechip">
            <FileIcon size={16} />
            <div>
              <p className="filechip__name">{f.name}</p>
              <p className="filechip__meta">{f.size} · загружено</p>
            </div>
            <button
              type="button"
              className="iconbtn filechip__del"
              onClick={() => setFiles(prev => prev.filter(x => x.name !== f.name))}
              aria-label="Удалить файл"
            >
              <TrashIcon size={15} />
            </button>
          </div>
        ))}
      </Field>
    </Modal>
  )
}

// ---------------- продукты ----------------

export function AdminProductsPage() {
  const { state, showToast } = useApp()
  const [addOpen, setAddOpen] = useState(false)
  const [newName, setNewName] = useState('')

  const products = useMemo(() => {
    const base = [...(state.dictionaries?.products ?? []), ...localList(LOCAL_PRODUCTS_KEY)]
    return [...new Set(base)].filter(p => p !== '' && p !== 'null').sort()
  }, [state.dictionaries])

  const counts = useMemo(() => {
    const map = new Map<string, { active: number; critical: Card | null; overdue: boolean; frozen: boolean }>()
    for (const card of state.cards.values()) {
      if (card.productName === null) continue
      const entry = map.get(card.productName) ?? { active: 0, critical: null, overdue: false, frozen: false }
      if (card.isActive) {
        entry.active += 1
        if (card.isCritical && entry.critical === null) entry.critical = card
        if (card.sla.state === 'breached') entry.overdue = true
      }
      if (state.freeze[card.id] !== undefined) entry.frozen = true
      map.set(card.productName, entry)
    }
    return map
  }, [state.cards, state.freeze])

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Продукты</h1>
          <p className="pagehead__sub">Множество продуктов задаёт администратор; инцидент привязывается к одному продукту</p>
        </div>
        <div className="pagehead__actions">
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            <PlusIcon size={15} />
            Добавить продукт
          </Button>
        </div>
      </div>

      <div className="cardsgrid">
        {products.map(name => {
          const info = counts.get(name)
          const alert =
            info?.critical !== null && info?.critical !== undefined
              ? info.critical.header
              : info?.overdue === true
                ? 'Просрочен SLA'
                : info?.frozen === true
                  ? 'Заморожен'
                  : null
          const dotColor = info?.critical !== null && info?.critical !== undefined ? 'var(--red)' : info?.overdue === true ? 'var(--red)' : info !== undefined && info.active > 0 ? 'var(--orange)' : 'var(--green)'
          return (
            <div key={name} className="pcard">
              <div className="pcard__top">
                <span className="pcard__icon">
                  <BoxIcon size={22} />
                </span>
              </div>
              <p className="pcard__name">{name}</p>
              <p className="pcard__team">Инцидентов открыто: {info?.active ?? 0}</p>
              <div className="pcard__foot">
                <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <span className="dot" style={{ background: dotColor }} />
                  {info === undefined || info.active === 0 ? 'Инцидентов нет' : `Открыто: ${info.active}`}
                </span>
                {alert !== null && <span className="pcard__alert">{alert}</span>}
              </div>
            </div>
          )
        })}
        <button
          type="button"
          className="pcard pcard--dashed"
          onClick={() => setAddOpen(true)}
        >
          <PlusIcon size={22} />
          Добавить продукт
        </button>
      </div>

      {addOpen && (
        <Modal
          title="Новый продукт"
          subtitle="Продукт появится в списке и в фильтрах"
          onClose={() => setAddOpen(false)}
          width={480}
          footer={
            <>
              <span className="spacer" />
              <Button variant="secondary" onClick={() => setAddOpen(false)}>
                Отмена
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const name = newName.trim()
                  if (name === '') {
                    showToast('Введите название продукта', 'warning')
                    return
                  }
                  saveLocalList(LOCAL_PRODUCTS_KEY, [...new Set([...localList(LOCAL_PRODUCTS_KEY), name])])
                  setNewName('')
                  setAddOpen(false)
                  showToast(`Продукт «${name}» добавлен`, 'success')
                }}
              >
                Добавить
              </Button>
            </>
          }
        >
          <Field label="Название продукта">
            <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Мой МТС — сайт" />
          </Field>
        </Modal>
      )}
    </>
  )
}

// ---------------- команды ----------------

export function AdminTeamsPage() {
  const { state, showToast } = useApp()
  const [selected, setSelected] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')

  const teams = useMemo(() => {
    const base = [...(state.dictionaries?.assignedGroups ?? []), ...localList(LOCAL_TEAMS_KEY)]
    return [...new Set(base)].filter(t => t !== '' && t !== 'null')
  }, [state.dictionaries])

  useEffect(() => {
    if (selected === null && teams.length > 0) setSelected(teams[0])
  }, [teams, selected])

  const teamStats = useMemo(() => {
    return teams.map(name => {
      const active = [...state.cards.values()].filter(c => c.isActive && c.assignedGroupName === name).length
      const members = [...new Set([...state.cards.values()].filter(c => c.assignedGroupName === name && c.assignedEmployee).map(c => c.assignedEmployee as string))]
      return { name, active, members }
    })
  }, [teams, state.cards])

  const memberRows = useMemo(() => {
    const team = teamStats.find(t => t.name === selected)
    if (team === undefined) return []
    return team.members.map(member => ({
      name: member,
      active: [...state.cards.values()].filter(c => c.isActive && c.assignedEmployee === member).length,
    }))
  }, [selected, teamStats, state.cards])

  const maxLoad = Math.max(1, ...teamStats.map(t => t.active))
  const developerCount = teamStats.reduce((sum, t) => sum + t.members.length, 0)

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Команды</h1>
          <p className="pagehead__sub">
            {teams.length} команд · {developerCount} исполнителей в инцидентах
          </p>
        </div>
        <div className="pagehead__actions">
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <PlusIcon size={15} />
            Создать команду
          </Button>
        </div>
      </div>

      <div className="teamgrid">
        {teamStats.map(team => (
          <div
            key={team.name}
            className={`teamcard teamcard--big ${selected === team.name ? 'teamcard--selected' : ''}`}
            onClick={() => setSelected(team.name)}
          >
            <div className="teamcard__head">
              <span className="teamcard__name">{team.name}</span>
              {selected === team.name ? (
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
            <div className="teamcard__people" style={{ marginTop: 16 }}>
              <span className="avatar-stack">
                {team.members.slice(0, 4).map(m => (
                  <Avatar key={m} size="sm" tone="blue" name={m} />
                ))}
                {team.members.length === 0 && <Avatar size="sm" tone="ghost" />}
              </span>
              <span style={{ marginLeft: 14 }}>
                {team.members.length} исполнител{team.members.length === 1 ? 'ь' : team.members.length < 5 ? 'я' : 'ей'} · по данным инцидентов
              </span>
            </div>
            <div className="loadrow" style={{ marginTop: 12 }}>
              <span>Загрузка</span>
              <span>
                <b>{Math.round((team.active / maxLoad) * 100)}%</b> · {team.active} инцидент{team.active === 1 ? '' : team.active < 5 ? 'а' : 'ов'}
              </span>
            </div>
            <div className="loadbar">
              <span className="loadbar__fill loadbar__fill--orange" style={{ width: `${Math.round((team.active / maxLoad) * 100)}%` }} />
            </div>
          </div>
        ))}
        <button type="button" className="pcard pcard--dashed" style={{ minHeight: 220 }} onClick={() => setCreateOpen(true)}>
          <PlusIcon size={22} />
          Создать команду
        </button>
      </div>

      <div className="sectiontitle">
        <h3>Состав команды {selected ?? ''}</h3>
        <Button
          variant="secondary"
          onClick={() => showToast('Участники команды определяются по назначениям в инцидентах', 'info')}
        >
          <PlusIcon size={15} />
          Добавить участника
        </Button>
      </div>
      {memberRows.length > 0 ? (
        <div className="tablecard">
          <table className="table">
            <thead>
              <tr>
                <th>Участник</th>
                <th>Грейд</th>
                <th>Загрузка</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {memberRows.map(row => (
                <tr key={row.name}>
                  <td>
                    <span className="memberrow">
                      <Avatar size="sm" tone="blue" name={row.name} />
                      {row.name}
                    </span>
                  </td>
                  <td className="table__muted">—</td>
                  <td>
                    Загрузка {row.active * 25}% · {row.active} инцидент{row.active === 1 ? '' : row.active < 5 ? 'а' : 'ов'}
                  </td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="В команде нет исполнителей" note="Участники появятся, когда инциденты команды будут назначены исполнителям" />
      )}

      {createOpen && (
        <Modal
          title="Новая команда"
          subtitle="Команда появится в списке назначения"
          onClose={() => setCreateOpen(false)}
          width={480}
          footer={
            <>
              <span className="spacer" />
              <Button variant="secondary" onClick={() => setCreateOpen(false)}>
                Отмена
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const name = newName.trim()
                  if (name === '') {
                    showToast('Введите название команды', 'warning')
                    return
                  }
                  saveLocalList(LOCAL_TEAMS_KEY, [...new Set([...localList(LOCAL_TEAMS_KEY), name])])
                  setNewName('')
                  setCreateOpen(false)
                  showToast(`Команда «${name}» создана`, 'success')
                }}
              >
                Создать
              </Button>
            </>
          }
        >
          <Field label="Название команды">
            <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Mobile" />
          </Field>
        </Modal>
      )}
    </>
  )
}

// ---------------- пользователи ----------------

export function AdminUsersPage() {
  const { showToast, pendingUsers, consumePending } = useApp()
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'all' | 'pending' | 'blocked'>('all')
  const [inviteOpen, setInviteOpen] = useState(false)

  const pending = pendingUsers()

  const reload = async () => {
    setLoading(true)
    try {
      const list = await api.fetchUsers()
      setUsers(list)
    } catch (err) {
      console.error('Не удалось загрузить пользователей', err)
      showToast('Не удалось загрузить пользователей', 'warning')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const assignPending = async (entry: { email: string; fullName: string }, role: Role) => {
    const password = `Radar-${Math.random().toString(36).slice(2, 10)}1`
    try {
      await api.createUser({ email: entry.email, password, fullName: entry.fullName, role })
      consumePending(entry.email)
      await reload()
      showToast(`${entry.email} — создан аккаунт, роль ${ROLE_LABELS[role]}`, 'success')
    } catch (err) {
      console.error('Не удалось создать пользователя', err)
      showToast(err instanceof Error && err.message !== '' ? err.message : 'Не удалось создать пользователя', 'warning')
    }
  }

  const changeRole = async (user: User, role: Role) => {
    try {
      await api.patchUser(user.id, { role })
      await reload()
      showToast(`${user.email} — роль ${ROLE_LABELS[role]}`, 'success')
    } catch (err) {
      console.error('Не удалось изменить роль', err)
      showToast('Не удалось изменить роль', 'warning')
    }
  }

  const removeUser = async (user: User) => {
    try {
      await api.deleteUser(user.id)
      await reload()
      showToast(`${user.email} заблокирован`, 'info')
    } catch (err) {
      console.error('Не удалось заблокировать пользователя', err)
      showToast('Не удалось заблокировать пользователя', 'warning')
    }
  }

  const rows = users

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Пользователи</h1>
          <p className="pagehead__sub">
            {users.length} пользователей · {pending.length} ждут назначения роли
          </p>
        </div>
        <div className="pagehead__actions">
          <Button variant="primary" onClick={() => setInviteOpen(true)}>
            <MailIcon size={15} />
            Пригласить
          </Button>
        </div>
      </div>

      <div className="toolrow">
        <div className="tabs">
          <button type="button" className={`tabs__tab ${tab === 'all' ? 'tabs__tab--active' : ''}`} onClick={() => setTab('all')}>
            Все · {users.length + pending.length}
          </button>
          <button type="button" className={`tabs__tab ${tab === 'pending' ? 'tabs__tab--active' : ''}`} onClick={() => setTab('pending')}>
            Ожидают роли · {pending.length}
          </button>
          <button type="button" className={`tabs__tab ${tab === 'blocked' ? 'tabs__tab--active' : ''}`} onClick={() => setTab('blocked')}>
            Заблокированы
          </button>
        </div>
      </div>

      {loading ? (
        <p style={{ color: 'var(--text-2)', padding: 24 }}>Загрузка…</p>
      ) : tab === 'pending' && pending.length === 0 ? (
        <EmptyState title="Заявок на роль нет" note="Новые регистрации появятся здесь после отправки формы регистрации" />
      ) : (
        <div className="tablecard">
          <table className="table">
            <thead>
              <tr>
                <th>Пользователь</th>
                <th>Почта</th>
                <th>Роль</th>
                <th>Логин ITSM</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tab === 'pending' &&
                pending.map(entry => (
                  <PendingRow key={entry.email} entry={entry} onAssign={role => void assignPending(entry, role)} />
                ))}
              {tab === 'all' && (
                <>
                  {pending.map(entry => (
                    <PendingRow key={entry.email} entry={entry} onAssign={role => void assignPending(entry, role)} />
                  ))}
                  {rows.map(user => (
                    <tr key={user.id}>
                      <td>
                        <span className="memberrow">
                          <Avatar size="sm" tone="blue" name={user.fullName ?? user.email} />
                          {user.fullName ?? user.email}
                        </span>
                      </td>
                      <td className="table__muted">{user.email}</td>
                      <td>
                        <RoleSelect role={user.role} onChange={role => void changeRole(user, role)} />
                      </td>
                      <td className="table__muted">{user.itsmLogin ?? '—'}</td>
                      <td>{user.deletedAt === null ? 'Активен' : 'Заблокирован'}</td>
                      <td style={{ textAlign: 'right' }}>
                        {user.role !== 'admin' && (
                          <button type="button" className="iconbtn" title="Заблокировать" onClick={() => void removeUser(user)}>
                            <TrashIcon size={15} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </>
              )}
            </tbody>
          </table>
        </div>
      )}

      {inviteOpen && (
        <InviteModal
          onClose={() => setInviteOpen(false)}
          onInvited={() => {
            setInviteOpen(false)
            void reload()
          }}
        />
      )}
    </>
  )
}

function PendingRow({ entry, onAssign }: { entry: { email: string; fullName: string }; onAssign: (role: Role) => void }) {
  const [role, setRole] = useState<Role>('coordinator')
  return (
    <tr style={{ background: 'rgba(245, 197, 24, 0.16)' }}>
      <td>
        <span className="memberrow">
          <Avatar size="sm" tone="ghost" />
          {entry.fullName}
        </span>
      </td>
      <td className="table__muted">{entry.email}</td>
      <td>
        <RoleSelect role={role} onChange={setRole} pending />
      </td>
      <td className="table__muted">—</td>
      <td>Ожидает роли</td>
      <td style={{ textAlign: 'right' }}>
        <Button variant="primary" className="btn--sm" onClick={() => onAssign(role)}>
          <UserIcon size={14} />
          Назначить
        </Button>
      </td>
    </tr>
  )
}

function RoleSelect({ role, onChange, pending = false }: { role: Role; onChange: (role: Role) => void; pending?: boolean }) {
  return (
    <select
      className="input"
      style={{ height: 36, width: 190, fontWeight: 600, background: pending ? 'rgba(245,197,24,0.2)' : undefined }}
      value={role}
      onChange={e => onChange(e.target.value as Role)}
    >
      {ROLE_OPTIONS.map(o => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function InviteModal({ onClose, onInvited }: { onClose: () => void; onInvited: () => void }) {
  const { showToast } = useApp()
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState<Role>('developer')
  const [itsmLogin, setItsmLogin] = useState('')
  const [password, setPassword] = useState(`Radar-${Math.random().toString(36).slice(2, 10)}1`)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (busy) return
    if (!email.includes('@')) {
      showToast('Введите корректную почту', 'warning')
      return
    }
    if (fullName.trim() === '') {
      showToast('Введите ФИО', 'warning')
      return
    }
    if (password.length < 8) {
      showToast('Пароль — минимум 8 символов', 'warning')
      return
    }
    setBusy(true)
    try {
      await api.createUser({ email: email.trim().toLowerCase(), password, fullName: fullName.trim(), role, itsmLogin: itsmLogin.trim() === '' ? undefined : itsmLogin.trim() })
      showToast(`${email} — приглашение создано, роль ${ROLE_LABELS[role]}`, 'success')
      onInvited()
    } catch (err) {
      console.error('Не удалось пригласить пользователя', err)
      showToast(err instanceof Error && err.message !== '' ? err.message : 'Не удалось пригласить пользователя', 'warning')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Пригласить пользователя"
      subtitle="Аккаунт создаётся сразу с выбранной ролью"
      onClose={onClose}
      width={560}
      footer={
        <>
          <span className="spacer" />
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            Пригласить
          </Button>
        </>
      }
    >
      <Field label="Рабочая почта">
        <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="a.ivanov@mts.ru" />
      </Field>
      <Field label="ФИО">
        <Input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Иванов Алексей Сергеевич" />
      </Field>
      <div className="formrow">
        <Field label="Роль">
          <select className="input" value={role} onChange={e => setRole(e.target.value as Role)}>
            {ROLE_OPTIONS.map(o => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Логин ITSM" hint="Для разработчика — как в инцидентах">
          <Input value={itsmLogin} onChange={e => setItsmLogin(e.target.value)} placeholder="a.ivanov" />
        </Field>
      </div>
      <Field label="Пароль" hint="Передайте пользователю — он сможет сменить его позже">
        <Input value={password} onChange={e => setPassword(e.target.value)} />
      </Field>
    </Modal>
  )
}

// ---------------- завершённые ----------------

export function AdminDonePage() {
  const { state, showToast, dispatch } = useApp()
  const [items, setItems] = useState<Card[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      try {
        const res = await api.fetchIncidents({ stateId: [10], perPage: 200, sort: 'submitDate', order: 'desc' })
        setItems(res.items)
      } catch (err) {
        console.error('Не удалось загрузить завершённые', err)
        showToast('Не удалось загрузить завершённые инциденты', 'warning')
      } finally {
        setLoading(false)
      }
    })()
  }, [showToast])

  const weekAgo = state.now - 7 * 86400000
  const closedWeek = items.filter(c => c.completionDate !== null && Date.parse(c.completionDate) >= weekAgo).length
  const resolutions = items
    .filter(c => c.submitDate !== null && c.completionDate !== null)
    .map(c => (Date.parse(c.completionDate as string) - Date.parse(c.submitDate as string)) / 60000)
  const avg = resolutions.length === 0 ? null : resolutions.reduce((a, b) => a + b, 0) / resolutions.length
  const withDeadline = items.filter(c => c.deadline !== null && c.completionDate !== null)
  const metRate =
    withDeadline.length === 0
      ? null
      : Math.round(
          (withDeadline.filter(c => Date.parse(c.completionDate as string) <= Date.parse(c.deadline as string)).length / withDeadline.length) * 100,
        )
  const overdue = items.filter(c => c.deadline !== null && c.completionDate !== null && Date.parse(c.completionDate) > Date.parse(c.deadline as string))

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Завершённые инциденты</h1>
          <p className="pagehead__sub">Закрыты после проверки — повторный сбой заводится как новый инцидент</p>
        </div>
        <div className="pagehead__actions">
          <a className="btn btn--secondary" href={api.exportUrl()} download>
            <DownloadIcon size={15} />
            Экспорт в CSV
          </a>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi">
          <p className="kpi__label">Закрыто за неделю</p>
          <p className="kpi__value">{closedWeek}</p>
          <p className="kpi__sub">всего закрыто: {items.length}</p>
        </div>
        <div className="kpi">
          <p className="kpi__label">Среднее время</p>
          <p className="kpi__value">{formatDurationWords(avg === null ? null : avg * 60)}</p>
          <p className="kpi__sub">от создания до закрытия</p>
        </div>
        <div className="kpi">
          <p className="kpi__label">В срок SLA</p>
          <p className="kpi__value">{metRate === null ? '—' : `${metRate}%`}</p>
          <p className="kpi__sub">закрыты до дедлайна</p>
        </div>
        <div className="kpi">
          <p className="kpi__label">С просрочкой</p>
          <p className="kpi__value kpi__value--red">{overdue.length}</p>
          <p className="kpi__sub">{overdue.length > 0 ? overdue[0].id : '—'}</p>
        </div>
      </div>

      <div style={{ height: 28 }} />
      {loading ? (
        <p style={{ color: 'var(--text-2)', padding: 24 }}>Загрузка…</p>
      ) : items.length === 0 ? (
        <EmptyState title="Пока нет закрытых инцидентов" note="Закрытые появятся после проверки исправлений" />
      ) : (
        <div className="tablecard">
          <table className="table">
            <thead>
              <tr>
                <th>№</th>
                <th>Название</th>
                <th>Приоритет</th>
                <th>Команда</th>
                <th>Решён за</th>
                <th>SLA</th>
                <th>Закрыт</th>
              </tr>
            </thead>
            <tbody>
              {items.map(card => {
                const resolvedIn =
                  card.submitDate !== null && card.completionDate !== null
                    ? (Date.parse(card.completionDate) - Date.parse(card.submitDate)) / 1000
                    : null
                const overDeadline =
                  card.deadline !== null && card.completionDate !== null && Date.parse(card.completionDate) > Date.parse(card.deadline)
                return (
                  <tr key={card.id} className="rowlink" onClick={() => dispatch({ type: 'OPEN_PANEL', id: card.id })}>
                    <td className="table__id">{card.id}</td>
                    <td className="table__title" style={{ maxWidth: 260 }}>{card.header ?? '—'}</td>
                    <td>
                      <SeverityBadge priorityId={card.priorityId} />
                    </td>
                    <td>{card.assignedGroupName ?? '—'}</td>
                    <td>{formatDurationWords(resolvedIn)}</td>
                    <td>
                      {overDeadline ? (
                        <span className="slachip slachip--breach">Просрочен</span>
                      ) : (
                        <span className="slachip slachip--done">В срок</span>
                      )}
                    </td>
                    <td className="table__muted">{relativeTime(card.completionDate, state.now)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
