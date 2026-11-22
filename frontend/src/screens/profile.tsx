import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ApiError, fetchMe, fetchMyTasks, fetchUser, fetchUserTasks, patchMe, unlinkTelegram } from '../api'
import { formatDayMonth } from '../format'
import { navigate } from '../router'
import { useApp } from '../store'
import { ROLE_LABELS } from '../types'
import type { Card, MeResponse, NotificationSettings, Role, User } from '../types'
import { Avatar, Button, CheckIcon, EmptyState, Field, Input, SeverityBadge, SlaChip, StatusPill } from '../ui'

const TASKS_NOTE: Record<Role, string> = {
  developer: 'Инциденты, где он исполнитель в ITSM или добавлен участником',
  viewer: 'Инциденты, ждущие проверки',
  coordinator: 'Принятые в работу и инциденты, куда пользователь добавлен участником',
  admin: 'Принятые в работу и инциденты, куда пользователь добавлен участником',
}

const MY_TASKS_NOTE: Record<Role, string> = {
  developer: 'Инциденты, где вы исполнитель в ITSM или добавлены участником',
  viewer: 'Инциденты, ждущие вашей проверки',
  coordinator: 'Принятые вами в работу и инциденты, куда вас добавили участником',
  admin: 'Принятые вами в работу и инциденты, куда вас добавили участником',
}

const CHANNELS: { key: 'inApp' | 'push' | 'telegram' | 'email'; label: string }[] = [
  { key: 'inApp', label: 'В приложении' },
  { key: 'push', label: 'Push (мобильное приложение)' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'email', label: 'Email' },
]

function TaskRow({ card, onClick }: { card: Card; onClick: () => void }) {
  const { state } = useApp()
  return (
    <div className="acard" onClick={onClick}>
      <div className="acard__top">
        <span className="acard__id">{card.id}</span>
        <SeverityBadge priorityId={card.priorityId} />
      </div>
      <p className="acard__title">{card.header ?? 'Без названия'}</p>
      <p className="acard__line">{card.productName ?? '—'}</p>
      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <StatusPill card={card} />
        <SlaChip card={card} now={state.now} frozen={card.freeze != null} />
      </div>
    </div>
  )
}

function CheckRow({ on, label, onToggle, children }: { on: boolean; label: string; onToggle: () => void; children?: ReactNode }) {
  return (
    <span className="checkrow" onClick={onToggle}>
      <span className={`checkbox ${on ? 'checkbox--on' : ''}`}>{on && <CheckIcon size={13} />}</span>
      {label}
      {children}
    </span>
  )
}

export function ProfilePage({ userId }: { userId?: string }) {
  const { state, dispatch, showToast } = useApp()
  const user = state.user
  const [me, setMe] = useState<MeResponse | null>(null)
  const [meError, setMeError] = useState(false)
  const [other, setOther] = useState<User | null>(null)
  const [otherError, setOtherError] = useState(false)
  const [name, setName] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [repeatPassword, setRepeatPassword] = useState('')
  const [channels, setChannels] = useState({ inApp: true, push: true, telegram: false, email: false })
  const [kinds, setKinds] = useState<Record<string, boolean>>({})
  const [savedSettings, setSavedSettings] = useState<NotificationSettings | null>(null)
  const [nameBusy, setNameBusy] = useState(false)
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [notifBusy, setNotifBusy] = useState(false)
  const [tasks, setTasks] = useState<Card[]>([])
  const [tasksLoading, setTasksLoading] = useState(true)
  const [includeResolved, setIncludeResolved] = useState(false)

  // свой профиль /profile; /profile/<id> — чужой, только просмотр
  const isSelf = userId === undefined || userId === (user?.id ?? '')

  useEffect(() => {
    if (!isSelf) return
    void (async () => {
      try {
        const m = await fetchMe()
        const s = m.notificationSettings
        setMe(m)
        setName(m.fullName ?? '')
        setChannels({ inApp: s.inApp, push: s.push, telegram: s.telegram, email: s.email })
        setKinds(Object.fromEntries(Object.keys(m.notificationKinds).map(k => [k, s.kinds[k] ?? true])))
        setSavedSettings(s)
      } catch (err) {
        console.error('Не удалось загрузить профиль', err)
        setMeError(true)
      }
    })()
  }, [isSelf])

  useEffect(() => {
    if (isSelf || userId === undefined) return
    setOther(null)
    setOtherError(false)
    void (async () => {
      try {
        setOther(await fetchUser(userId))
      } catch (err) {
        console.error('Не удалось загрузить профиль пользователя', err)
        setOtherError(true)
      }
    })()
  }, [isSelf, userId])

  // карточки задач кладём и в общий store: панель инцидента открывается только по карточке из state.cards
  const tasksUserId = isSelf ? '' : (other?.id ?? '')
  useEffect(() => {
    if (!isSelf && tasksUserId === '') return
    void (async () => {
      setTasksLoading(true)
      try {
        const res = isSelf ? await fetchMyTasks(includeResolved) : await fetchUserTasks(tasksUserId, includeResolved)
        setTasks(res.items)
        dispatch({ type: 'UPSERT_CARDS', cards: res.items })
      } catch (err) {
        console.error('Не удалось загрузить задачи', err)
        showToast(isSelf ? 'Не удалось загрузить ваши задачи' : 'Не удалось загрузить задачи пользователя', 'warning')
      } finally {
        setTasksLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeResolved, isSelf, tasksUserId])

  if (user === null) return null

  const profileUser: User | null = isSelf ? me : other
  if (profileUser === null) {
    return (
      <p className="loading-text" style={{ paddingTop: 40 }}>
        {isSelf
          ? meError
            ? 'Не удалось загрузить профиль — обновите страницу'
            : 'Загрузка…'
          : otherError
            ? 'Профиль не найден — пользователь заблокирован или удалён'
            : 'Загрузка…'}
      </p>
    )
  }

  const applyUser = (updated: User | null) => {
    if (updated === null) return
    dispatch({ type: 'SET_USER', user: updated })
    setMe(prev => (prev === null ? prev : { ...prev, ...updated }))
  }

  const saveName = async () => {
    const trimmed = name.trim()
    if (trimmed === '') {
      showToast('Имя не может быть пустым', 'warning')
      return
    }
    setNameBusy(true)
    try {
      applyUser(await patchMe({ fullName: trimmed }))
      showToast('Имя обновлено', 'success')
    } catch (err) {
      if (err instanceof ApiError) showToast(err.message, 'warning')
      else {
        console.error('Не удалось сохранить имя', err)
        showToast('Не удалось сохранить: сервер недоступен', 'critical')
      }
    } finally {
      setNameBusy(false)
    }
  }

  const savePassword = async () => {
    if (currentPassword === '') {
      showToast('Укажите текущий пароль', 'warning')
      return
    }
    if (newPassword.length < 8) {
      showToast('Новый пароль — минимум 8 символов', 'warning')
      return
    }
    if (newPassword !== repeatPassword) {
      showToast('Пароли не совпадают', 'warning')
      return
    }
    setPasswordBusy(true)
    try {
      await patchMe({ currentPassword, newPassword })
      setCurrentPassword('')
      setNewPassword('')
      setRepeatPassword('')
      showToast('Пароль изменён', 'success')
    } catch (err) {
      if (err instanceof ApiError) showToast(err.message, 'warning')
      else {
        console.error('Не удалось сменить пароль', err)
        showToast('Не удалось сменить пароль: сервер недоступен', 'critical')
      }
    } finally {
      setPasswordBusy(false)
    }
  }

  const notifDirty =
    savedSettings !== null &&
    (channels.inApp !== savedSettings.inApp ||
      channels.push !== savedSettings.push ||
      channels.telegram !== savedSettings.telegram ||
      channels.email !== savedSettings.email ||
      Object.keys(kinds).some(k => kinds[k] !== savedSettings.kinds[k]))

  const saveNotifications = async () => {
    const settings: NotificationSettings = { ...channels, kinds }
    setNotifBusy(true)
    try {
      applyUser(await patchMe({ notificationSettings: settings }))
      setSavedSettings(settings)
      showToast('Настройки уведомлений сохранены', 'success')
    } catch (err) {
      if (err instanceof ApiError) showToast(err.message, 'warning')
      else {
        console.error('Не удалось сохранить уведомления', err)
        showToast('Не удалось сохранить: сервер недоступен', 'critical')
      }
    } finally {
      setNotifBusy(false)
    }
  }

  const unlink = async () => {
    try {
      await unlinkTelegram()
      applyUser(await fetchMe())
      showToast('Telegram отключён', 'success')
    } catch (err) {
      if (err instanceof ApiError) showToast(err.message, 'warning')
      else {
        console.error('Не удалось отвязать Telegram', err)
        showToast('Не удалось отвязать Telegram: сервер недоступен', 'critical')
      }
    }
  }

  // сотрудникам инцидент открывается в боковой панели; разработчик и тестировщик работают на своих экранах
  const openTask = (card: Card) => {
    if (user.role === 'coordinator' || user.role === 'admin') {
      navigate('/')
      dispatch({ type: 'OPEN_PANEL', id: card.id })
      return
    }
    navigate(user.role === 'developer' ? '/dev' : '/qa')
  }

  const tgLinked = profileUser.telegramChatId !== null && profileUser.telegramChatId !== ''
  const nameUnchanged = name.trim() === '' || name.trim() === (me?.fullName ?? '')

  const tasksCard = (
    <div className="profilecard">
      <h3>{isSelf ? 'Мои задачи' : 'Задачи'}</h3>
      <p className="profilecard__sub">{isSelf ? MY_TASKS_NOTE[profileUser.role] : TASKS_NOTE[profileUser.role]}</p>
      <CheckRow on={includeResolved} label="Показать решённые и закрытые" onToggle={() => setIncludeResolved(v => !v)} />
      <p className="listlabel">Всего · {tasks.length}</p>
      {tasksLoading ? (
        <p className="loading-text" style={{ color: 'var(--text-2)' }}>Загрузка…</p>
      ) : tasks.length === 0 ? (
        <EmptyState title="Задач нет" note={includeResolved ? undefined : 'Новые назначения появятся здесь и придут уведомлением'} />
      ) : (
        tasks.map(card => <TaskRow key={card.id} card={card} onClick={() => openTask(card)} />)
      )}
    </div>
  )

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Профиль</h1>
          <p className="pagehead__sub">
            {isSelf ? 'Личные данные, уведомления и ваши задачи' : 'Профиль коллеги — редактировать можно только свой'}
          </p>
        </div>
      </div>

      <div className="profilehead">
        <Avatar size="xl" tone="blue" name={profileUser.fullName ?? profileUser.email} />
        <div className="profilehead__id">
          <p className="profilehead__name">{profileUser.fullName ?? profileUser.email}</p>
          <p className="profilehead__mail">{profileUser.email}</p>
          <div className="profilehead__tags">
            <span className="tag">{ROLE_LABELS[profileUser.role]}</span>
            <span className="tag">{tgLinked ? 'Telegram подключён' : 'Telegram не подключён'}</span>
          </div>
        </div>
        <div className="profilehead__facts">
          {profileUser.role === 'developer' && (
            <>
              <div className="profilefact">
                <p className="profilefact__label">Команда</p>
                <p className="profilefact__value">{profileUser.team ?? '—'}</p>
              </div>
              <div className="profilefact">
                <p className="profilefact__label">Логин ITSM</p>
                <p className="profilefact__value">{profileUser.itsmLogin ?? '—'}</p>
              </div>
            </>
          )}
          <div className="profilefact">
            <p className="profilefact__label">В системе с</p>
            <p className="profilefact__value">{formatDayMonth(profileUser.createdAt)}</p>
          </div>
        </div>
      </div>

      {isSelf ? (
        <div className="split">
          {tasksCard}

          <div className="profilestack">
            <div className="profilecard">
              <h3>Личные данные</h3>
              <p className="profilecard__sub">Имя видно коллегам — в шапке, в карточках инцидентов и в истории</p>
              <Field label="Имя" hint={`${name.length}/200`}>
                <Input value={name} maxLength={200} placeholder="Иванов Иван" onChange={e => setName(e.target.value)} />
              </Field>
              <div className="profileformfoot">
                <span className="spacer" />
                <Button variant="primary" disabled={nameBusy || nameUnchanged} onClick={() => void saveName()}>
                  Сохранить
                </Button>
              </div>
            </div>

            <div className="profilecard">
              <h3>Смена пароля</h3>
              <p className="profilecard__sub">Минимум 8 символов; для подтверждения нужен текущий пароль</p>
              <Field label="Текущий пароль">
                <Input type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} />
              </Field>
              <div className="formrow">
                <Field label="Новый пароль">
                  <Input type="password" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} />
                </Field>
                <Field label="Повторите новый пароль">
                  <Input type="password" autoComplete="new-password" value={repeatPassword} onChange={e => setRepeatPassword(e.target.value)} />
                </Field>
              </div>
              <div className="profileformfoot">
                <span className="spacer" />
                <Button variant="primary" disabled={passwordBusy} onClick={() => void savePassword()}>
                  Изменить пароль
                </Button>
              </div>
            </div>

            <div className="profilecard">
              <h3>Уведомления</h3>
              <p className="profilecard__sub">Куда и о чём сообщать</p>
              <p className="listlabel" style={{ marginTop: 0 }}>Куда присылать</p>
              {CHANNELS.map(ch => (
                <CheckRow
                  key={ch.key}
                  on={channels[ch.key]}
                  label={ch.label}
                  onToggle={() => setChannels(prev => ({ ...prev, [ch.key]: !prev[ch.key] }))}
                >
                  {ch.key === 'telegram' && tgLinked && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      style={{ marginLeft: 'auto' }}
                      onClick={e => {
                        e.stopPropagation()
                        void unlink()
                      }}
                    >
                      Отвязать
                    </button>
                  )}
                </CheckRow>
              ))}
              {!tgLinked && <p className="profilecard__hint">Telegram подключается в боте — напишите ему /start</p>}
              <p className="listlabel">О чём сообщать</p>
              <div className="checklist">
                {Object.entries(me?.notificationKinds ?? {}).map(([kind, label]) => (
                  <CheckRow key={kind} on={kinds[kind] === true} label={label} onToggle={() => setKinds(prev => ({ ...prev, [kind]: !prev[kind] }))} />
                ))}
              </div>
              <div className="profileformfoot">
                <span className="spacer" />
                <Button variant="primary" disabled={notifBusy || !notifDirty} onClick={() => void saveNotifications()}>
                  Сохранить
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        tasksCard
      )}
    </>
  )
}
