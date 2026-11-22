import { useCallback, useEffect, useState } from 'react'
import { ApiError, fetchTeamProfile } from '../api'
import { formatDayMonth, pluralize } from '../format'
import { navigate } from '../router'
import { useApp } from '../store'
import type { Card, TeamMember, TeamProfileResponse } from '../types'
import { ROLE_LABELS } from '../types'
import { Avatar, Button, EmptyState, Loading, StarRating, TeamIcon } from '../ui'
import { ErrorScreen } from './error'
import { TaskRow } from './profile'

const VISIBLE_LIMIT = 8

function personCount(n: number): string {
  return `${n} ${pluralize(n, 'участник', 'участника', 'участников')}`
}

function MemberRow({ member }: { member: TeamMember }) {
  const profileHref = member.id === null ? null : `/profile/${member.id}`
  const openProfile = () => {
    if (profileHref === null) return
    navigate(profileHref)
  }
  return (
    <div
      className={`memberrow teamroster__row${profileHref === null ? '' : ' teamroster__row--link'}`}
      role={profileHref === null ? undefined : 'link'}
      tabIndex={profileHref === null ? undefined : 0}
      title={profileHref === null ? undefined : 'Открыть профиль'}
      onClick={profileHref === null ? undefined : openProfile}
      onKeyDown={
        profileHref === null
          ? undefined
          : e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                openProfile()
              }
            }
      }
    >
      <Avatar size="sm" tone={member.kind === 'account' ? 'blue' : 'ghost'} name={member.name} />
      <div className="teamroster__id">
        {profileHref === null ? (
          <span>{member.name}</span>
        ) : (
          <a
            href={profileHref}
            onClick={e => {
              e.preventDefault()
              openProfile()
            }}
          >
            {member.name}
          </a>
        )}
        <p className="table__muted">
          {member.role === null ? 'Исполнитель ITSM' : ROLE_LABELS[member.role]}
          {member.itsmLogin !== null && member.itsmLogin !== '' ? ` · ${member.itsmLogin}` : ''}
        </p>
      </div>
      <span className="teamroster__rating">
        {member.rating === null ? (
          '—'
        ) : (
          <>
            <StarRating value={member.rating.average} size={13} />
            <span>{member.rating.average} · {member.rating.count}</span>
          </>
        )}
      </span>
      <span className="teamroster__load">{member.active} в работе · {member.done} сделано</span>
    </div>
  )
}

function MembersCard({ members }: { members: TeamMember[] }) {
  const accounts = members.filter(m => m.kind === 'account').length
  const executors = members.length - accounts
  return (
    <div className="profilecard">
      <h3>Состав команды</h3>
      <p className="profilecard__sub">
        {accounts} с аккаунтом · {executors} исполнителей по данным инцидентов
      </p>
      {members.length === 0 ? (
        <EmptyState title="Участников нет" note="Добавьте разработчиков в команду или назначьте исполнителей в инцидентах" />
      ) : (
        <div className="teamroster">
          {members.map(member => <MemberRow key={member.id ?? member.name} member={member} />)}
        </div>
      )}
    </div>
  )
}

function RatingCard({ profile }: { profile: TeamProfileResponse }) {
  const { rating } = profile
  const ratedMembers = rating.ratedMembers
  const accountMembers = profile.members.filter(m => m.kind === 'account').length
  return (
    <div className="profilecard">
      <h3>Рейтинг команды</h3>
      <p className="profilecard__sub">Средняя оценка по всем отзывам об участниках команды</p>
      <div className="ratingsummary">
        {rating.average === null ? (
          <span style={{ color: 'var(--text-2)', fontSize: 14 }}>Оценок пока нет</span>
        ) : (
          <>
            <span className="ratingsummary__value">{rating.average}</span>
            <StarRating value={rating.average} size={18} />
          </>
        )}
        <span className="ratingsummary__count">
          {rating.count} {pluralize(rating.count, 'оценка', 'оценки', 'оценок')}
        </span>
      </div>
      <p className="profilecard__hint">
        Оценки получили {ratedMembers} из {accountMembers} участников с аккаунтом
      </p>
    </div>
  )
}

function IncidentsCard({
  title,
  sub,
  items,
  emptyTitle,
  emptyNote,
  expanded,
  onToggle,
  onOpen,
}: {
  title: string
  sub: string
  items: Card[]
  emptyTitle: string
  emptyNote: string
  expanded: boolean
  onToggle: () => void
  onOpen: (card: Card) => void
}) {
  const shown = expanded ? items : items.slice(0, VISIBLE_LIMIT)
  return (
    <div className="profilecard">
      <h3>{title} · {items.length}</h3>
      <p className="profilecard__sub">{sub}</p>
      {items.length === 0 ? (
        <EmptyState title={emptyTitle} note={emptyNote} />
      ) : (
        <>
          {shown.map(card => <TaskRow key={card.id} card={card} onClick={() => onOpen(card)} />)}
          {items.length > VISIBLE_LIMIT && (
            <button type="button" className="btn btn--ghost btn--sm" style={{ marginTop: 10 }} onClick={onToggle}>
              {expanded ? 'Свернуть' : `Показать все (${items.length})`}
            </button>
          )}
        </>
      )}
    </div>
  )
}

export function TeamProfilePage({ name }: { name: string }) {
  const { state, dispatch } = useApp()
  const [profile, setProfile] = useState<TeamProfileResponse | null>(null)
  const [error, setError] = useState<'notFound' | 'server' | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [showAllAssigned, setShowAllAssigned] = useState(false)
  const [showAllDone, setShowAllDone] = useState(false)

  const load = useCallback(async () => {
    try {
      setProfile(await fetchTeamProfile(name))
      setError(null)
    } catch (err) {
      console.error('Не удалось загрузить профиль команды', err)
      setError(err instanceof ApiError && err.status === 404 ? 'notFound' : 'server')
    }
  }, [name])

  useEffect(() => {
    setProfile(null)
    setError(null)
    setShowAllAssigned(false)
    setShowAllDone(false)
    void load()
    const onChange = () => void load()
    // инциденты меняют загрузку и список задач, пользователи — состав и оценки
    window.addEventListener('radar:incident-changed', onChange)
    window.addEventListener('radar:users-changed', onChange)
    window.addEventListener('radar:team-changed', onChange)
    return () => {
      window.removeEventListener('radar:incident-changed', onChange)
      window.removeEventListener('radar:users-changed', onChange)
      window.removeEventListener('radar:team-changed', onChange)
    }
  }, [load, retryKey])

  const openTask = (card: Card) => {
    if (state.user?.role === 'viewer') {
      navigate('/qa')
      return
    }
    navigate('/')
    dispatch({ type: 'OPEN_PANEL', id: card.id })
  }

  if (error !== null) {
    return (
      <ErrorScreen
        code={error === 'notFound' ? 404 : 500}
        text={
          error === 'notFound'
            ? 'Команда не найдена — возможно, она была удалена или переименована.'
            : 'Не удалось загрузить профиль команды.'
        }
        onRetry={error === 'server' ? () => setRetryKey(k => k + 1) : undefined}
        onHome={() => navigate(state.user?.role === 'admin' ? '/admin/teams' : '/')}
      />
    )
  }

  if (profile === null) return <Loading style={{ paddingTop: 40 }} />

  const { rating } = profile
  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Профиль команды</h1>
          <p className="pagehead__sub">Состав, загрузка и результаты работы команды</p>
        </div>
        {state.user?.role === 'admin' && (
          <div className="pagehead__actions">
            <Button variant="secondary" onClick={() => navigate('/admin/teams')}>
              <TeamIcon size={15} />
              Управление командами
            </Button>
          </div>
        )}
      </div>

      <div className="profilehead">
        <Avatar size="xl" tone="violet" name={profile.name} />
        <div className="profilehead__id">
          <p className="profilehead__name">{profile.name}</p>
          <p className="profilehead__mail">Команда исполнителей</p>
          <div className="profilehead__tags">
            <span className="tag">{personCount(profile.members.length)}</span>
            <span className="tag">
              {rating.average === null
                ? 'Оценок пока нет'
                : `★ ${rating.average} · ${rating.count} ${pluralize(rating.count, 'оценка', 'оценки', 'оценок')}`}
            </span>
            <span className="tag">{profile.assigned.length} в работе</span>
            <span className="tag">{profile.done.length} выполнено</span>
          </div>
        </div>
        <div className="profilehead__facts">
          <div className="profilefact">
            <p className="profilefact__label">В справочнике с</p>
            <p className="profilefact__value">
              {profile.createdAt === null ? 'из данных инцидентов' : formatDayMonth(profile.createdAt)}
            </p>
          </div>
          <div className="profilefact">
            <p className="profilefact__label">Выполнено инцидентов</p>
            <p className="profilefact__value">{profile.done.length}</p>
          </div>
        </div>
      </div>

      <div className="split">
        <div className="profilestack">
          <MembersCard members={profile.members} />
          <RatingCard profile={profile} />
        </div>
        <div className="profilestack">
          <IncidentsCard
            title="Назначено"
            sub="Активные инциденты команды — что сейчас в работе"
            items={profile.assigned}
            emptyTitle="Назначенных инцидентов нет"
            emptyNote="Новые назначения появятся здесь"
            expanded={showAllAssigned}
            onToggle={() => setShowAllAssigned(v => !v)}
            onOpen={openTask}
          />
          <IncidentsCard
            title="Выполнено"
            sub="Завершённые и закрытые инциденты команды"
            items={profile.done}
            emptyTitle="Выполненных инцидентов нет"
            emptyNote="Завершённые инциденты появятся здесь"
            expanded={showAllDone}
            onToggle={() => setShowAllDone(v => !v)}
            onOpen={openTask}
          />
        </div>
      </div>
    </>
  )
}
