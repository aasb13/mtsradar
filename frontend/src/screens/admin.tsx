import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../api'
import { formatDurationWords, formatShort, priorityMeta, relativeTime } from '../format'
import { useApp } from '../store'
import type { Card, Invite, RegistrationRequest, Role, User } from '../types'
import { PRIORITY_SLA_HOURS, PRIORITIES, ROLE_LABELS } from '../types'
import { FilterChipMenu, KpiRow, SLA_LABELS } from './kanban'
import {
  AlertIcon,
  Avatar,
  BoxIcon,
  Button,
  DotsIcon,
  DownloadIcon,
  EmptyState,
  Field,
  FileIcon,
  Input,
  LinkIcon,
  MailIcon,
  Modal,
  PlusIcon,
  Select,
  SeverityBadge,
  SlaChip,
  StatusPill,
  Textarea,
  TrashIcon,
  UploadIcon,
  UserIcon,
  stringOptions,
} from '../ui'

const ROLE_OPTIONS: { key: Role; label: string }[] = [
  { key: 'coordinator', label: 'Координатор' },
  { key: 'developer', label: 'Разработчик' },
  { key: 'viewer', label: 'Тестировщик' },
  { key: 'admin', label: 'Администратор' },
]

// приглашений на роль admin не бывает
const INVITE_ROLE_OPTIONS = ROLE_OPTIONS.filter(o => o.key !== 'admin')

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
          <Button variant="secondary" onClick={() => void api.downloadExport('json').catch(err => showToast(err.message, 'warning'))}>
            <DownloadIcon size={15} />
            Экспорт
          </Button>
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
        <p className="loading-text" style={{ color: 'var(--text-2)', padding: 24 }}>Загрузка…</p>
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
                    <StatusPill card={card} />
                  </td>
                  <td>{card.assignedGroupName ?? '—'}</td>
                  <td>
                    <SlaChip card={card} now={state.now} frozen={card.freeze != null} />
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

  const products = state.dictionaries?.products ?? []
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
          <Select value={product} options={stringOptions(products)} onChange={setProduct} />
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
  const { state, dispatch, showToast } = useApp()
  const [addOpen, setAddOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [manage, setManage] = useState<string | null>(null)

  const products = useMemo(
    () => (state.dictionaries?.products ?? []).filter(p => p !== '' && p !== 'null').sort(),
    [state.dictionaries],
  )

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
      if (card.freeze != null) entry.frozen = true
      map.set(card.productName, entry)
    }
    return map
  }, [state.cards])

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
                <button
                  type="button"
                  className="iconbtn"
                  aria-label={`Изменить продукт ${name}`}
                  onClick={() => setManage(name)}
                >
                  <DotsIcon size={16} />
                </button>
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
                  dispatch({ type: 'ADD_DICT_ITEMS', field: 'products', items: [name] })
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

      {manage !== null && <DictItemModal field="products" name={manage} onClose={() => setManage(null)} />}
    </>
  )
}

// ---------------- изменение и удаление продукта/команды ----------------

function DictItemModal({
  field,
  name,
  onClose,
  developers = [],
  reloadUsers,
}: {
  field: 'products' | 'assignedGroups'
  name: string
  onClose: () => void
  developers?: User[]
  reloadUsers?: () => Promise<void>
}) {
  const { state, dispatch, doRenameDictItem, showToast, refreshDictionaries } = useApp()
  const [value, setValue] = useState(name)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [memberBusy, setMemberBusy] = useState(false)
  const [addId, setAddId] = useState('')
  const isProduct = field === 'products'
  const trimmed = value.trim()

  const inTeam = useMemo(() => developers.filter(d => d.team === name), [developers, name])
  const candidates = useMemo(() => developers.filter(d => d.team !== name), [developers, name])
  const candidateOptions = useMemo(
    () =>
      candidates.map(d => ({
        value: d.id,
        label: `${d.fullName ?? d.email}${d.team !== null ? ` · сейчас в «${d.team}»` : ''}`,
      })),
    [candidates],
  )
  const addValue = candidates.some(d => d.id === addId) ? addId : (candidates[0]?.id ?? '')

  const openCount = useMemo(
    () =>
      [...state.cards.values()].filter(c => c.isActive && (isProduct ? c.productName : c.assignedGroupName) === name)
        .length,
    [state.cards, isProduct, name],
  )

  const rename = async () => {
    if (busy || trimmed === '' || trimmed === name) return
    setBusy(true)
    const ok = await doRenameDictItem(field, name, trimmed)
    if (ok && !isProduct) await reloadUsers?.()
    setBusy(false)
    if (ok) onClose()
  }

  const addMember = async () => {
    const dev = candidates.find(d => d.id === addValue)
    if (dev === undefined || reloadUsers === undefined || memberBusy) return
    setMemberBusy(true)
    try {
      await api.patchUser(dev.id, { team: name })
      await reloadUsers()
      showToast(`${dev.fullName ?? dev.email} добавлен в команду «${name}»`, 'success')
    } catch (err) {
      if (err instanceof api.ApiError) showToast(err.message, 'warning')
      else {
        console.error('Не удалось добавить участника в команду', err)
        showToast('Не удалось добавить участника в команду', 'warning')
      }
    } finally {
      setMemberBusy(false)
    }
  }

  const removeMember = async (user: User) => {
    if (reloadUsers === undefined || memberBusy) return
    setMemberBusy(true)
    try {
      await api.patchUser(user.id, { team: null })
      await reloadUsers()
      showToast(`${user.fullName ?? user.email} убран из команды «${name}»`, 'info')
    } catch (err) {
      if (err instanceof api.ApiError) showToast(err.message, 'warning')
      else {
        console.error('Не удалось убрать участника из команды', err)
        showToast('Не удалось убрать участника из команды', 'warning')
      }
    } finally {
      setMemberBusy(false)
    }
  }

  const remove = async () => {
    if (!confirming) {
      setConfirming(true)
      return
    }
    // команда из базы удаляется на сервере; выведенные из инцидентов значения скрываются локально
    if (!isProduct && (state.dictionaries?.customTeams ?? []).includes(name)) {
      try {
        await api.deleteTeam(name)
      } catch (err) {
        if (err instanceof api.ApiError) showToast(err.message, 'warning')
        else {
          console.error('Не удалось удалить команду', err)
          showToast('Не удалось удалить команду: сервер недоступен', 'critical')
        }
        return
      }
    }
    dispatch({ type: 'REMOVE_DICT_ITEM', field, name })
    await refreshDictionaries()
    showToast(isProduct ? `Продукт «${name}» удалён из справочника` : `Команда «${name}» удалена из справочника`, 'info')
    onClose()
  }

  return (
    <Modal
      title={isProduct ? `Продукт «${name}»` : `Команда «${name}»`}
      subtitle={`Открытых инцидентов: ${openCount}`}
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button variant="danger" onClick={() => void remove()}>
            {confirming ? 'Подтвердить удаление' : 'Удалить'}
          </Button>
          <span className="spacer" />
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" disabled={busy || trimmed === '' || trimmed === name} onClick={() => void rename()}>
            Сохранить
          </Button>
        </>
      }
    >
      <Field label="Новое название" hint="Инциденты с этим значением обновятся автоматически">
        <Input value={value} onChange={e => setValue(e.target.value)} />
      </Field>
      <p className="modal__info">
        <AlertIcon size={15} />
        удаление убирает значение из списков и фильтров; инциденты сохранят его в истории
      </p>
      {!isProduct && (
        <>
          <p className="psection" style={{ marginTop: 20 }}>Разработчики в команде</p>
          {inTeam.length === 0 ? (
            <p className="modal__info" style={{ marginBottom: 14 }}>
              разработчиков с аккаунтом в команде пока нет — добавьте ниже
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
              {inTeam.map(user => (
                <div key={user.id} className="memberrow" style={{ justifyContent: 'space-between' }}>
                  <span className="memberrow">
                    <Avatar size="sm" tone="blue" name={user.fullName ?? user.email} />
                    <span>
                      {user.fullName ?? user.email}
                      {user.itsmLogin !== null && user.itsmLogin !== '' && (
                        <span className="table__muted" style={{ fontSize: 12 }}> · {user.itsmLogin}</span>
                      )}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="iconbtn"
                    aria-label={`Убрать ${user.fullName ?? user.email} из команды`}
                    onClick={() => void removeMember(user)}
                  >
                    <TrashIcon size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {candidates.length === 0 ? (
            <p className="modal__info" style={{ marginBottom: 0 }}>все разработчики с аккаунтом уже в команде</p>
          ) : (
            <Field label="Добавить разработчика">
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <Select value={addValue} options={candidateOptions} onChange={setAddId} />
                </div>
                <Button variant="secondary" disabled={memberBusy} onClick={() => void addMember()}>
                  <PlusIcon size={15} />
                  Добавить
                </Button>
              </div>
            </Field>
          )}
        </>
      )}
    </Modal>
  )
}

// ---------------- команды ----------------

type TeamMemberRow =
  | { kind: 'account'; user: User; load: number }
  | { kind: 'executor'; name: string; load: number }

export function AdminTeamsPage() {
  const { state, dispatch, showToast, refreshDictionaries } = useApp()
  const [users, setUsers] = useState<User[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [manage, setManage] = useState<string | null>(null)

  const reloadUsers = useCallback(async () => {
    try {
      setUsers(await api.fetchUsers())
    } catch (err) {
      console.error('Не удалось загрузить пользователей', err)
      showToast('Не удалось загрузить список разработчиков', 'warning')
    }
  }, [showToast])

  useEffect(() => {
    void reloadUsers()
  }, [reloadUsers])

  const teams = useMemo(
    () => (state.dictionaries?.assignedGroups ?? []).filter(t => t !== '' && t !== 'null'),
    [state.dictionaries],
  )

  useEffect(() => {
    if (selected === null && teams.length > 0) setSelected(teams[0])
  }, [teams, selected])

  useEffect(() => {
    if (selected !== null && !teams.includes(selected)) setSelected(null)
  }, [teams, selected])

  const developers = useMemo(
    () => users.filter(u => u.role === 'developer' && u.deletedAt === null),
    [users],
  )

  const teamStats = useMemo(() => {
    return teams.map(name => {
      const active = [...state.cards.values()].filter(c => c.isActive && c.assignedGroupName === name).length
      const executors = [...new Set([...state.cards.values()].filter(c => c.assignedGroupName === name && c.assignedEmployee).map(c => c.assignedEmployee as string))]
      const accounts = developers.filter(d => d.team === name)
      const accountNames = new Set(accounts.map(d => d.fullName ?? d.email ?? ''))
      const members = [...new Set([...executors.filter(n => !accountNames.has(n)), ...accounts.map(d => d.fullName ?? d.email ?? '')])]
      return { name, active, members, executors, accounts }
    })
  }, [teams, state.cards, developers])

  const memberRows = useMemo<TeamMemberRow[]>(() => {
    const team = teamStats.find(t => t.name === selected)
    if (team === undefined || selected === null) return []
    const all = [...state.cards.values()]
    const rows: TeamMemberRow[] = team.accounts.map(user => ({
      kind: 'account',
      user,
      load: all.filter(
        c =>
          c.isActive
          && c.assignedGroupName === selected
          && ((user.itsmLogin !== null && c.assignedEmployeeLogin === user.itsmLogin) || c.members.includes(user.id)),
      ).length,
    }))
    for (const name of team.executors) {
      rows.push({ kind: 'executor', name, load: all.filter(c => c.isActive && c.assignedEmployee === name).length })
    }
    return rows
  }, [selected, teamStats, state.cards])

  const removeMember = async (user: User) => {
    if (selected === null) return
    try {
      await api.patchUser(user.id, { team: null })
      await reloadUsers()
      showToast(`${user.fullName ?? user.email} убран из команды «${selected}»`, 'info')
    } catch (err) {
      if (err instanceof api.ApiError) showToast(err.message, 'warning')
      else {
        console.error('Не удалось убрать участника из команды', err)
        showToast('Не удалось убрать участника из команды', 'warning')
      }
    }
  }

  const maxLoad = Math.max(1, ...teamStats.map(t => t.active))
  const developerCount = teamStats.reduce((sum, t) => sum + t.members.length, 0)

  const createTeam = async () => {
    const name = newName.trim()
    if (name === '') {
      showToast('Введите название команды', 'warning')
      return
    }
    if (creating) return
    setCreating(true)
    try {
      await api.createTeam(name)
      // имя могло быть скрыто на этом браузере после прошлого удаления — возвращаем его
      dispatch({ type: 'RESTORE_DICT_ITEM', field: 'assignedGroups', name })
      await refreshDictionaries()
      setNewName('')
      setCreateOpen(false)
      showToast(`Команда «${name}» создана`, 'success')
    } catch (err) {
      if (err instanceof api.ApiError) showToast(err.message, 'warning')
      else {
        console.error('Не удалось создать команду', err)
        showToast('Не удалось создать команду: сервер недоступен', 'critical')
      }
    } finally {
      setCreating(false)
    }
  }

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
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {selected === team.name && (
                  <span className="teamcard__check">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m5 12.5 4.5 4.5L19 7.5" />
                    </svg>
                  </span>
                )}
                <button
                  type="button"
                  className="iconbtn"
                  aria-label={`Изменить команду ${team.name}`}
                  onClick={e => {
                    e.stopPropagation()
                    setManage(team.name)
                  }}
                >
                  <DotsIcon size={16} />
                </button>
              </span>
            </div>
            <div className="teamcard__people" style={{ marginTop: 16 }}>
              <span className="avatar-stack">
                {team.members.slice(0, 4).map(m => (
                  <Avatar key={m} size="sm" tone="blue" name={m} />
                ))}
                {team.members.length === 0 && <Avatar size="sm" tone="ghost" />}
              </span>
              <span style={{ marginLeft: 14 }}>
                {team.members.length} исполнител{team.members.length === 1 ? 'ь' : team.members.length < 5 ? 'я' : 'ей'}
                {team.accounts.length > 0 ? ` · ${team.accounts.length} с аккаунтом` : ' · по данным инцидентов'}
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
          onClick={() => {
            if (selected === null) {
              showToast('Сначала создайте команду', 'warning')
              return
            }
            setManage(selected)
          }}
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
              {memberRows.map(row =>
                row.kind === 'account' ? (
                  <tr key={`u-${row.user.id}`}>
                    <td>
                      <span className="memberrow">
                        <Avatar size="sm" tone="blue" name={row.user.fullName ?? row.user.email} />
                        <span>
                          {row.user.fullName ?? row.user.email}
                          <span className="table__muted" style={{ display: 'block', fontSize: 12 }}>{row.user.email}</span>
                        </span>
                      </span>
                    </td>
                    <td className="table__muted">—</td>
                    <td>
                      Загрузка {row.load * 25}% · {row.load} инцидент{row.load === 1 ? '' : row.load < 5 ? 'а' : 'ов'}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="iconbtn"
                        aria-label={`Убрать ${row.user.fullName ?? row.user.email} из команды`}
                        onClick={() => void removeMember(row.user)}
                      >
                        <TrashIcon size={15} />
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={`e-${row.name}`}>
                    <td>
                      <span className="memberrow">
                        <Avatar size="sm" tone="blue" name={row.name} />
                        {row.name}
                      </span>
                    </td>
                    <td className="table__muted">—</td>
                    <td>
                      Загрузка {row.load * 25}% · {row.load} инцидент{row.load === 1 ? '' : row.load < 5 ? 'а' : 'ов'}
                    </td>
                    <td />
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="В команде нет исполнителей"
          note="Добавьте разработчика через «Добавить участника» или назначьте исполнителей в инцидентах"
        />
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
              <Button variant="primary" disabled={creating} onClick={() => void createTeam()}>
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

      {manage !== null && (
        <DictItemModal
          field="assignedGroups"
          name={manage}
          onClose={() => setManage(null)}
          developers={developers}
          reloadUsers={reloadUsers}
        />
      )}
    </>
  )
}

// ---------------- пользователи ----------------

export function AdminUsersPage() {
  const { state, showToast } = useApp()
  const [users, setUsers] = useState<User[]>([])
  const [requests, setRequests] = useState<RegistrationRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'all' | 'pending' | 'blocked'>('all')
  const [inviteOpen, setInviteOpen] = useState(false)

  const load = async () => {
    try {
      const [list, reqs] = await Promise.all([api.fetchUsers(), api.fetchRegistrationRequests()])
      setUsers(list)
      setRequests(reqs)
    } catch (err) {
      console.error('Не удалось загрузить пользователей', err)
      showToast('Не удалось загрузить пользователей', 'warning')
    }
  }

  const reload = async () => {
    setLoading(true)
    await load()
    setLoading(false)
  }

  useEffect(() => {
    void reload()
    // новые заявки и решения приходят по WebSocket — молча обновляем список
    const onChange = () => void load()
    window.addEventListener('radar:registration', onChange)
    return () => window.removeEventListener('radar:registration', onChange)
  }, [])

  const approve = async (request: RegistrationRequest, role: Role, itsmLogin: string) => {
    try {
      await api.approveRegistrationRequest(request.id, role, itsmLogin)
      showToast(`${request.email} — аккаунт создан, роль ${ROLE_LABELS[role]}`, 'success')
    } catch (err) {
      console.error('Не удалось одобрить заявку', err)
      showToast(err instanceof Error && err.message !== '' ? err.message : 'Не удалось одобрить заявку', 'warning')
    }
    await load()
  }

  const reject = async (request: RegistrationRequest) => {
    try {
      await api.rejectRegistrationRequest(request.id)
      showToast(`Заявка ${request.email} отклонена`, 'info')
    } catch (err) {
      console.error('Не удалось отклонить заявку', err)
      showToast(err instanceof Error && err.message !== '' ? err.message : 'Не удалось отклонить заявку', 'warning')
    }
    await load()
  }

  const changeRole = async (user: User, role: Role) => {
    try {
      await api.patchUser(user.id, { role })
      await reload()
      showToast(`${user.email} — роль ${ROLE_LABELS[role]}`, 'success')
    } catch (err) {
      console.error('Не удалось изменить роль', err)
      showToast(err instanceof Error && err.message !== '' ? err.message : 'Не удалось изменить роль', 'warning')
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
            {users.length} пользователей · {requests.length} заявок ждут решения
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
            Все · {users.length + requests.length}
          </button>
          <button type="button" className={`tabs__tab ${tab === 'pending' ? 'tabs__tab--active' : ''}`} onClick={() => setTab('pending')}>
            Заявки · {requests.length}
          </button>
          <button type="button" className={`tabs__tab ${tab === 'blocked' ? 'tabs__tab--active' : ''}`} onClick={() => setTab('blocked')}>
            Заблокированы
          </button>
        </div>
      </div>

      {loading ? (
        <p className="loading-text" style={{ color: 'var(--text-2)', padding: 24 }}>Загрузка…</p>
      ) : tab === 'pending' && requests.length === 0 ? (
        <EmptyState title="Заявок на регистрацию нет" note="Новые заявки появятся здесь сразу после отправки формы регистрации" />
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
                requests.map(request => (
                  <PendingRow
                    key={request.id}
                    request={request}
                    onApprove={(role, itsmLogin) => void approve(request, role, itsmLogin)}
                    onReject={() => void reject(request)}
                  />
                ))}
              {tab === 'all' && (
                <>
                  {requests.map(request => (
                    <PendingRow
                      key={request.id}
                      request={request}
                      onApprove={(role, itsmLogin) => void approve(request, role, itsmLogin)}
                      onReject={() => void reject(request)}
                    />
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
                        {user.id === state.user?.id ? (
                          ROLE_LABELS[user.role]
                        ) : (
                          <RoleSelect role={user.role} onChange={role => void changeRole(user, role)} />
                        )}
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

      <InvitesSection />

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

// ---------------- приглашения на ветку ----------------

/** Ссылка собирается на клиенте (бэкенд не знает свой внешний адрес). Роль в ссылке —
 * только для подсказки на форме регистрации: настоящая роль лежит в токене на сервере. */
function inviteLink(invite: Invite): string {
  return `${window.location.origin}/register?invite=${invite.token}&role=${invite.role}`
}

function InvitesSection() {
  const { showToast } = useApp()
  const [role, setRole] = useState<Role>('coordinator')
  const [itsmLogin, setItsmLogin] = useState('')
  const [created, setCreated] = useState<Invite | null>(null)
  const [invites, setInvites] = useState<Invite[]>([])
  const [busy, setBusy] = useState(false)

  const reload = async () => {
    try {
      setInvites(await api.fetchInvites())
    } catch (err) {
      console.error('Не удалось загрузить приглашения', err)
      showToast('Не удалось загрузить приглашения', 'warning')
    }
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copy = async (invite: Invite) => {
    try {
      await navigator.clipboard.writeText(inviteLink(invite))
      showToast('Ссылка скопирована — отправьте её сотруднику', 'success')
    } catch (err) {
      console.error('Не удалось скопировать ссылку', err)
      showToast('Не удалось скопировать — выделите и скопируйте ссылку вручную', 'warning')
    }
  }

  const create = async () => {
    if (busy) return
    const login = itsmLogin.trim()
    if (role === 'developer' && login === '') {
      showToast('Для приглашения разработчика нужен логин ITSM', 'warning')
      return
    }
    setBusy(true)
    try {
      const invite = await api.createInvite({ role, itsmLogin: login === '' ? undefined : login })
      setCreated(invite)
      await reload()
      showToast('Ссылка готова — она сработает один раз', 'success')
    } catch (err) {
      console.error('Не удалось создать приглашение', err)
      showToast(err instanceof Error && err.message !== '' ? err.message : 'Не удалось создать приглашение', 'warning')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (invite: Invite) => {
    try {
      await api.revokeInvite(invite.token)
      if (created !== null && created.token === invite.token) setCreated(null)
      await reload()
      showToast('Приглашение отозвано', 'info')
    } catch (err) {
      console.error('Не удалось отозвать приглашение', err)
      showToast(err instanceof Error && err.message !== '' ? err.message : 'Не удалось отозвать приглашение', 'warning')
    }
  }

  return (
    <>
      <div className="sectiontitle">
        <h3>Приглашения</h3>
        <span style={{ color: 'var(--text-3)', fontSize: 13 }}>
          Одноразовая ссылка: аккаунт с выбранной ролью создаётся сразу, без заявки
        </span>
      </div>
      <div className="tablecard" style={{ padding: 16 }}>
        <div className="formrow">
          <Field label="Роль">
            <Select
              value={role}
              options={INVITE_ROLE_OPTIONS.map(o => ({ value: o.key, label: o.label }))}
              onChange={setRole}
            />
          </Field>
          {role === 'developer' && (
            <Field label="Логин ITSM" hint="Как в инцидентах (assignedEmployeeLogin)">
              <Input value={itsmLogin} onChange={e => setItsmLogin(e.target.value)} placeholder="a.ivanov" />
            </Field>
          )}
        </div>
        <div style={{ marginTop: 12 }}>
          <Button variant="primary" disabled={busy} onClick={() => void create()}>
            <LinkIcon size={15} />
            Создать ссылку
          </Button>
        </div>
        {created !== null && (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
            <Input
              readOnly
              value={inviteLink(created)}
              onFocus={e => e.currentTarget.select()}
              style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
            />
            <Button variant="secondary" onClick={() => void copy(created)}>
              <LinkIcon size={15} />
              Скопировать
            </Button>
          </div>
        )}
        {invites.length === 0 ? (
          <p style={{ color: 'var(--text-3)', fontSize: 13, marginTop: 12 }}>Активных приглашений нет</p>
        ) : (
          <table className="table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Роль</th>
                <th>Логин ITSM</th>
                <th>Действует до</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invites.map(invite => (
                <tr key={invite.token}>
                  <td style={{ fontWeight: 600 }}>{ROLE_LABELS[invite.role]}</td>
                  <td className="table__muted">{invite.itsmLogin ?? '—'}</td>
                  <td className="table__muted">{formatShort(invite.expiresAt)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Button variant="secondary" className="btn--sm" onClick={() => void revoke(invite)}>
                      Отозвать
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

function PendingRow({
  request,
  onApprove,
  onReject,
}: {
  request: RegistrationRequest
  onApprove: (role: Role, itsmLogin: string) => void
  onReject: () => void
}) {
  const [role, setRole] = useState<Role>('coordinator')
  const [itsmLogin, setItsmLogin] = useState('')
  return (
    <tr style={{ background: 'rgba(245, 197, 24, 0.16)' }}>
      <td>
        <span className="memberrow">
          <Avatar size="sm" tone="ghost" />
          {request.fullName}
        </span>
      </td>
      <td className="table__muted">{request.email}</td>
      <td>
        <RoleSelect role={role} onChange={setRole} pending />
      </td>
      <td>
        <input
          className="input"
          style={{ height: 36, width: 170 }}
          value={itsmLogin}
          onChange={e => setItsmLogin(e.target.value)}
          placeholder="для разработчика"
          aria-label="Логин ITSM"
        />
      </td>
      <td>Ожидает решения</td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <Button variant="secondary" className="btn--sm" onClick={onReject}>
          Отклонить
        </Button>{' '}
        <Button variant="primary" className="btn--sm" onClick={() => onApprove(role, itsmLogin.trim())}>
          <UserIcon size={14} />
          Одобрить
        </Button>
      </td>
    </tr>
  )
}

function RoleSelect({ role, onChange, pending = false }: { role: Role; onChange: (role: Role) => void; pending?: boolean }) {
  return (
    <Select
      className={`select--compact ${pending ? 'select--pending' : ''}`}
      value={role}
      options={ROLE_OPTIONS.map(o => ({ value: o.key, label: o.label }))}
      onChange={onChange}
    />
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
          <Select value={role} options={ROLE_OPTIONS.map(o => ({ value: o.key, label: o.label }))} onChange={setRole} />
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
          <Button variant="secondary" onClick={() => void api.downloadExport('csv').catch(err => showToast(err.message, 'warning'))}>
            <DownloadIcon size={15} />
            Экспорт в CSV
          </Button>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi">
          <p className="kpi__label">Закрыто за неделю</p>
          <p className="kpi__value" key={closedWeek}>{closedWeek}</p>
          <p className="kpi__sub">всего закрыто: {items.length}</p>
        </div>
        <div className="kpi">
          <p className="kpi__label">Среднее время</p>
          <p className="kpi__value" key={formatDurationWords(avg === null ? null : avg * 60)}>{formatDurationWords(avg === null ? null : avg * 60)}</p>
          <p className="kpi__sub">от создания до закрытия</p>
        </div>
        <div className="kpi">
          <p className="kpi__label">В срок SLA</p>
          <p className="kpi__value" key={metRate}>{metRate === null ? '—' : `${metRate}%`}</p>
          <p className="kpi__sub">закрыты до дедлайна</p>
        </div>
        <div className="kpi">
          <p className="kpi__label">С просрочкой</p>
          <p className="kpi__value kpi__value--red" key={overdue.length}>{overdue.length}</p>
          <p className="kpi__sub">{overdue.length > 0 ? overdue[0].id : '—'}</p>
        </div>
      </div>

      <div style={{ height: 28 }} />
      {loading ? (
        <p className="loading-text" style={{ color: 'var(--text-2)', padding: 24 }}>Загрузка…</p>
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
