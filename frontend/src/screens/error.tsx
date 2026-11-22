import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { navigate } from '../router'
import { AlertIcon, ArrowRightIcon, Button, RefreshIcon, SearchIcon } from '../ui'

export type ErrorCode = 404 | 403 | 500

const COPY: Record<ErrorCode, { title: string; text: string; hint: string }> = {
  404: {
    title: 'Страница не найдена',
    text: 'Такого раздела нет — ссылка устарела, страница перемещена или в адресе опечатка.',
    hint: 'Проверьте адрес или вернитесь на главную.',
  },
  403: {
    title: 'Нет доступа',
    text: 'У вашей роли нет прав на этот раздел.',
    hint: 'На главной доступны все разделы, которые вам положены.',
  },
  500: {
    title: 'Что-то пошло не так',
    text: 'Не удалось отобразить страницу.',
    hint: 'Попробуйте ещё раз. Если ошибка повторится, обновите страницу.',
  },
}

function LockIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

const ICON: Record<ErrorCode, ReactNode> = {
  404: <SearchIcon size={20} />,
  403: <LockIcon />,
  500: <AlertIcon size={20} />,
}

export function ErrorScreen({
  code,
  text,
  onRetry,
  onHome,
  standalone = false,
}: {
  code: ErrorCode
  text?: string
  onRetry?: () => void
  onHome?: () => void
  standalone?: boolean
}) {
  const copy = COPY[code]
  const goHome = onHome ?? (() => navigate('/'))
  return (
    <section className={`err err--${code}${standalone ? ' err--standalone' : ''}`} role="alert">
      <div className="err__mark">
        <span className="err__code">{code}</span>
        <span className="err__icon">{ICON[code]}</span>
      </div>
      <h1 className="err__title">{copy.title}</h1>
      <p className="err__text">{text ?? copy.text}</p>
      <p className="err__hint">{copy.hint}</p>
      <div className="err__actions">
        {onRetry !== undefined && (
          <Button variant="primary" onClick={onRetry}>
            <RefreshIcon size={16} />
            Повторить
          </Button>
        )}
        <Button variant={onRetry === undefined ? 'primary' : 'secondary'} onClick={goHome}>
          <ArrowRightIcon size={16} />
          На главную
        </Button>
      </div>
    </section>
  )
}

interface BoundaryProps {
  children: ReactNode
}

interface BoundaryState {
  failed: boolean
}

/** Ловит сбой при отрисовке любого экрана: вместо пустой страницы — собственный экран 500. */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Неожиданный сбой интерфейса', error, info.componentStack)
  }

  private retry = (): void => {
    this.setState({ failed: false })
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <ErrorScreen
          code={500}
          standalone
          onRetry={this.retry}
          onHome={() => {
            this.retry()
            navigate('/')
          }}
        />
      )
    }
    return this.props.children
  }
}
