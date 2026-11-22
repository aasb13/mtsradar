import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ApiError, fetchMe, fetchMyTasks, fetchUser, fetchUserRatings, fetchUserTasks, patchMe, rateUser, unlinkTelegram } from '../api'
import { formatDayMonth, pluralize, relativeTime } from '../format'
import { navigate } from '../router'
import { ErrorScreen } from './error'
import { useApp } from '../store'
import { ROLE_LABELS } from '../types'
import type { Card, MeResponse, NotificationSettings, RatingsResponse, Role, User } from '../types'
import { Avatar, Button, CheckIcon, EmptyState, Field, Input, Loading, SeverityBadge, SlaChip, StarPicker, StarRating, StatusPill, Textarea } from '../ui'

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

export function TaskRow({ card, onClick }: { card: Card; onClick: () => void }) {
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
  const [retryKey, setRetryKey] = useState(0)
  const [ratings, setRatings] = useState<RatingsResponse | null>(null)
  const [ratingScore, setRatingScore] = useState(0)
  const [ratingComment, setRatingComment] = useState('')
  const [ratingAnonymous, setRatingAnonymous] = useState(false)
  const [ratingBusy, setRatingBusy] = useState(false)

  // свой профиль /profile; /profile/<id> — чужой, только просмотр
  const isSelf = userId === undefined || userId === (user?.id ?? '')

  const loadMe = async () => {
    setMeError(false)
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
  }

  useEffect(() => {
    if (!isSelf) return
    void loadMe()
    const onChange = () => void loadMe()
    window.addEventListener('radar:users-changed', onChange)
    return () => window.removeEventListener('radar:users-changed', onChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSelf, retryKey])

  const loadOther = async () => {
    setOtherError(false)
    try {
      setOther(await fetchUser(userId as string))
    } catch (err) {
      console.error('Не удалось загрузить профиль пользователя', err)
      setOtherError(true)
    }
  }

  useEffect(() => {
    if (isSelf || userId === undefined) return
    setOther(null)
    void loadOther()
    const onChange = (e: Event) => {
      const updated = (e as CustomEvent<User>).detail
      if (updated === undefined || updated.id === userId) void loadOther()
    }
    window.addEventListener('radar:users-changed', onChange)
    return () => window.removeEventListener('radar:users-changed', onChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSelf, userId, retryKey])

  // карточки задач кладём и в общий store: панель инцидента открывается только по карточке из state.cards
  const tasksUserId = isSelf ? '' : (other?.id ?? '')
  const loadTasks = async () => {
    if (!isSelf && tasksUserId === '') return
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
  }

  useEffect(() => {
    void loadTasks()
    const onChange = () => void loadTasks()
    window.addEventListener('radar:incident-changed', onChange)
    return () => window.removeEventListener('radar:incident-changed', onChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeResolved, isSelf, tasksUserId])

  // отзывы о пользователе; свой рейтинг — тоже по id, чтобы работало после правки имени
  const ratingsUserId = other?.id ?? (isSelf ? (user?.id ?? '') : '')
  useEffect(() => {
    if (ratingsUserId === '') return
    void (async () => {
      try {
        setRatings(await fetchUserRatings(ratingsUserId))
      } catch (err) {
        console.error('Не удалось загрузить оценки', err)
        showToast(isSelf ? 'Не удалось загрузить ваши оценки' : 'Не удалось загрузить оценки пользователя', 'warning')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSelf, ratingsUserId, retryKey])

  const retryProfile = () => {
    setMeError(false)
    setOtherError(false)
    setRetryKey(key => key + 1)
  }

  if (user === null) return null

  const profileUser: User | null = isSelf ? me : other
  if (profileUser === null) {
    const error = isSelf ? meError : otherError
    return error ? (
      isSelf ? (
        <ErrorScreen code={500} text="Не удалось загрузить профиль." onRetry={retryProfile} />
      ) : (
        <ErrorScreen code={404} text="Профиль не найден — пользователь заблокирован или удалён." />
      )
    ) : (
      <Loading style={{ paddingTop: 40 }} />
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

  const submitRating = async () => {
    if (ratingScore === 0) {
      showToast('Выберите оценку — звёзды от 1 до 5', 'warning')
      return
    }
    setRatingBusy(true)
    try {
      setRatings(
        await rateUser(profileUser.id, {
          score: ratingScore,
          comment: ratingComment.trim() === '' ? undefined : ratingComment.trim(),
          anonymous: ratingAnonymous,
        }),
      )
      setRatingScore(0)
      setRatingComment('')
      setRatingAnonymous(false)
      showToast('Оценка отправлена — коллега получит уведомление', 'success')
    } catch (err) {
      if (err instanceof ApiError) showToast(err.message, 'warning')
      else {
        console.error('Не удалось отправить оценку', err)
        showToast('Не удалось отправить оценку: сервер недоступен', 'critical')
      }
    } finally {
      setRatingBusy(false)
    }
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
        <Loading />
      ) : tasks.length === 0 ? (
        <EmptyState title="Задач нет" note={includeResolved ? undefined : 'Новые назначения появятся здесь и придут уведомлением'} />
      ) : (
        tasks.map(card => <TaskRow key={card.id} card={card} onClick={() => openTask(card)} />)
      )}
    </div>
  )

  const ratingsCard = (
    <div className="profilecard">
      <h3>{isSelf ? 'Мой рейтинг' : 'Рейтинг'}</h3>
      <p className="profilecard__sub">
        {isSelf
          ? 'Оценки и отзывы коллег о вашей работе'
          : 'Оценки коллег: у открытых отзывов виден автор, анонимные — без имени'}
      </p>
      {ratings === null ? (
        <Loading />
      ) : (
        <>
          <div className="ratingsummary">
            {ratings.average !== null ? (
              <>
                <span className="ratingsummary__value">{ratings.average}</span>
                <StarRating value={ratings.average} size={18} />
              </>
            ) : (
              <span style={{ color: 'var(--text-2)', fontSize: 14 }}>Оценок пока нет</span>
            )}
            <span className="ratingsummary__count">
              {ratings.count} {pluralize(ratings.count, 'оценка', 'оценки', 'оценок')}
            </span>
          </div>

          {!isSelf && (
            <div className="ratingform">
              <p className="listlabel" style={{ marginTop: 0 }}>Оставить оценку</p>
              <StarPicker value={ratingScore} onChange={setRatingScore} />
              <Field label="Комментарий" hint={`${ratingComment.length}/1000`}>
                <Textarea
                  maxLength={1000}
                  value={ratingComment}
                  placeholder="Что получилось и что стоит улучшить"
                  onChange={e => setRatingComment(e.target.value)}
                />
              </Field>
              <CheckRow
                on={ratingAnonymous}
                label="Анонимно — автор отзыва не будет показан"
                onToggle={() => setRatingAnonymous(v => !v)}
              />
              <div className="profileformfoot">
                <span className="spacer" />
                <Button variant="primary" disabled={ratingBusy || ratingScore === 0} onClick={() => void submitRating()}>
                  Оценить
                </Button>
              </div>
            </div>
          )}

          {ratings.items.length > 0 && (
            <div className="reviewlist">
              <p className="listlabel">Отзывы · {ratings.items.length}</p>
              {ratings.items.map(r => {
                const author = r.author
                return (
                  <div key={r.id} className="reviewrow">
                    <div className="reviewrow__head">
                      {author === null ? (
                        <span className="reviewrow__anon">Анонимный отзыв</span>
                      ) : (
                        <a
                          className="reviewrow__author"
                          href={`/profile/${author.id}`}
                          title="Открыть профиль"
                          onClick={e => {
                            e.preventDefault()
                            navigate(`/profile/${author.id}`)
                          }}
                        >
                          {author.name}
                        </a>
                      )}
                      <StarRating value={r.score} />
                      <span className="reviewrow__date">{relativeTime(r.createdAt, state.now)}</span>
                    </div>
                    {r.comment !== '' && <p className="reviewrow__text">{r.comment}</p>}
                  </div>
                )
              })}
            </div>
          )}
        </>
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
            <span className="tag">
              {ratings === null
                ? '—'
                : ratings.count === 0
                  ? 'Оценок пока нет'
                  : `★ ${ratings.average} · ${ratings.count} ${pluralize(ratings.count, 'оценка', 'оценки', 'оценок')}`}
            </span>
            <span className="tag">{tgLinked ? 'Telegram подключён' : 'Telegram не подключён'}</span>
          </div>
        </div>
        <div className="profilehead__facts">
          {profileUser.role === 'developer' && (
            <>
              <div className="profilefact">
                <p className="profilefact__label">Команда</p>
                <p className="profilefact__value">
                  {profileUser.team === null || profileUser.team === '' ? (
                    '—'
                  ) : user.role === 'developer' ? (
                    profileUser.team
                  ) : (
                    <a
                      href={`/team/${encodeURIComponent(profileUser.team)}`}
                      title="Открыть профиль команды"
                      onClick={e => {
                        e.preventDefault()
                        navigate(`/team/${encodeURIComponent(profileUser.team)}`)
                      }}
                    >
                      {profileUser.team}
                    </a>
                  )}
                </p>
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
          <div className="profilestack">
            {tasksCard}
            {ratingsCard}
          </div>

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
        <div className="profilestack">
          {tasksCard}
          {ratingsCard}
        </div>
      )}
    </>
  )
}
