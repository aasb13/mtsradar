import { useState } from 'react'
import { navigate } from '../router'
import { useApp } from '../store'
import { BellIcon, SparkIcon, ClockIcon, AlertIcon } from '../ui'

function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth">
      <div className="auth__left">
        <div className="auth__brand">
          МТС
          <br />
          РАДАР
        </div>
        <div>
          <p className="auth__tagline">Координация массовых инцидентов в реальном времени</p>
          <div className="feature">
            <span className="feature__icon">
              <ClockIcon size={26} />
            </span>
            <div>
              <p className="feature__title">Живые SLA-таймеры</p>
              <p className="feature__text">Видно, сколько осталось до дедлайна по каждому инциденту</p>
            </div>
          </div>
          <div className="feature">
            <span className="feature__icon">
              <SparkIcon size={26} />
            </span>
            <div>
              <p className="feature__title">ИИ-ассистент BigDad</p>
              <p className="feature__text">Подсказывает, кому передать инцидент, и оценивает риск</p>
            </div>
          </div>
          <div className="feature">
            <span className="feature__icon">
              <BellIcon size={26} />
            </span>
            <div>
              <p className="feature__title">Мгновенные уведомления</p>
              <p className="feature__text">В браузере, в Telegram и в мобильном приложении</p>
            </div>
          </div>
        </div>
        <p className="auth__copyright">© 2026 МТС · внутренний сервис</p>
      </div>
      <div className="auth__right">
        <div className="auth__form">{children}</div>
      </div>
    </div>
  )
}

export function LoginPage() {
  const { state, login } = useApp()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const error = state.authError

  return (
    <AuthLayout>
      <h1>Вход в Радар</h1>
      <p className="auth__form-sub">Используйте рабочую почту и пароль</p>
      {error !== null && (
        <div className="authbanner authbanner--error">
          <AlertIcon size={18} />
          {error}
        </div>
      )}
      <form
        onSubmit={e => {
          e.preventDefault()
          void login(email, password, remember)
        }}
      >
        <label className="field">
          <span className="field__label">Почта</span>
          <input
            className={`input${error !== null ? ' input--error' : ''}`}
            type="email"
            value={email}
            autoComplete="username"
            onChange={e => setEmail(e.target.value)}
            placeholder="name@mts.ru"
            required
          />
          <span className="field__hint">Рабочая почта @mts.ru</span>
        </label>
        <label className="field">
          <span className="field__label">Пароль</span>
          <input
            className={`input${error !== null ? ' input--error' : ''}`}
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={e => setPassword(e.target.value)}
            placeholder="••••••••"
            required
          />
          <span className="field__hint">Минимум 8 символов</span>
        </label>
        <div className="auth__row">
          <button
            type="button"
            className="remember"
            onClick={() => setRemember(!remember)}
            aria-pressed={remember}
          >
            <span className={`checkbox--red ${remember ? 'checkbox--on' : ''}`}>
              {remember && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                </svg>
              )}
            </span>
            Запомнить меня
          </button>
          <a className="auth__link" href="#/login" onClick={e => e.preventDefault()}>
            Забыли пароль?
          </a>
        </div>
        <button className="btn btn--primary" style={{ width: '100%' }} type="submit" disabled={state.authInProgress}>
          {state.authInProgress ? 'Входим…' : 'Войти'}
        </button>
      </form>
      <p className="auth__alt">
        Нет аккаунта?{' '}
        <a
          href="#/register"
          onClick={e => {
            e.preventDefault()
            navigate('/register')
          }}
        >
          Зарегистрироваться
        </a>
      </p>
      <div className="infobox">
        <AlertIcon size={16} />
        Роль (координатор, разработчик, тестировщик) назначает администратор после регистрации
      </div>
    </AuthLayout>
  )
}

export function RegisterPage() {
  const { registerPending, showToast } = useApp()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !email.toLowerCase().endsWith('@mts.ru')) {
      setError('Только рабочая почта домена @mts.ru')
      return
    }
    if (password.length < 8) {
      setError('Пароль — минимум 8 символов, буквы и цифры')
      return
    }
    if (password !== confirm) {
      setError('Пароли не совпадают')
      return
    }
    setError(null)
    registerPending(email.trim().toLowerCase(), fullName.trim())
    showToast('Заявка на регистрацию отправлена', 'success')
    navigate('/pending')
  }

  return (
    <AuthLayout>
      <h1>Регистрация</h1>
      <p className="auth__form-sub">Создайте аккаунт — роль назначит администратор</p>
      <form onSubmit={submit}>
        <label className="field">
          <span className="field__label">ФИО</span>
          <input className="input" value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Иванов Алексей Сергеевич" required />
          <span className="field__hint">Как в корпоративном профиле</span>
        </label>
        <label className="field">
          <span className="field__label">Почта</span>
          <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="a.ivanov@mts.ru" required />
          <span className="field__hint">Только домен @mts.ru</span>
        </label>
        <label className="field">
          <span className="field__label">Пароль</span>
          <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required />
          <span className="field__hint">Минимум 8 символов, буквы и цифры</span>
        </label>
        <label className="field">
          <span className="field__label">Повторите пароль</span>
          <input className="input" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="••••••••" required />
          <span className="field__hint">{confirm === '' ? null : confirm === password ? 'Пароли совпадают' : 'Пароли не совпадают'}</span>
        </label>
        {error !== null && <div className="authbanner authbanner--error">{error}</div>}
        <button className="btn btn--primary" style={{ width: '100%' }} type="submit">
          Создать аккаунт
        </button>
      </form>
      <p className="auth__alt">
        Уже есть аккаунт?{' '}
        <a
          href="#/login"
          onClick={e => {
            e.preventDefault()
            navigate('/login')
          }}
        >
          Войти
        </a>
      </p>
    </AuthLayout>
  )
}

export function PendingPage() {
  const { logout, pendingUsers } = useApp()
  const pending = pendingUsers()
  const last = pending.length > 0 ? pending[pending.length - 1] : null
  return (
    <AuthLayout>
      <div className="pendingicon">
        <ClockIcon size={36} />
      </div>
      <h1 style={{ lineHeight: 1.15 }}>Заявка на рассмотрении</h1>
      <p className="auth__form-sub" style={{ maxWidth: 470 }}>
        Аккаунт создан. Администратор назначит вам роль — обычно это занимает до 30 минут в рабочее время.
      </p>
      <div className="waitcard">
        <div className="waitcard__row">
          <p className="waitcard__label">Почта</p>
          <p className="waitcard__value">{last !== null ? last.email : '—'}</p>
        </div>
        <div className="waitcard__row">
          <p className="waitcard__label">Отправлено</p>
          <p className="waitcard__value">сегодня, {new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date())}</p>
        </div>
        <div className="waitcard__row">
          <p className="waitcard__label">Статус</p>
          <p className="waitcard__value">
            <span className="waitdot" />
            Ожидает роли
          </p>
        </div>
      </div>
      <div className="infobox" style={{ marginTop: 0 }}>
        <AlertIcon size={16} />
        Мы пришлём письмо и уведомление в Telegram, когда роль будет назначена
      </div>
      <button
        className="btn btn--secondary"
        style={{ width: '100%', marginTop: 20 }}
        onClick={() => {
          void logout()
        }}
      >
        Выйти
      </button>
    </AuthLayout>
  )
}
