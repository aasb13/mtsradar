import { useEffect } from 'react'
import { useDashboard, type ToastItem } from '../store'
import { IconClose, IconWarning } from './Icons'

function Toast({ item }: { item: ToastItem }) {
  const { dispatch } = useDashboard()

  useEffect(() => {
    if (item.sticky) return
    const timer = window.setTimeout(() => dispatch({ type: 'DISMISS_TOAST', key: item.key }), 6000)
    return () => window.clearTimeout(timer)
  }, [item, dispatch])

  const showIcon = item.type === 'critical' || item.type === 'warning'
  return (
    <div className={`toast toast--${item.type}`}>
      {showIcon && <IconWarning size={15} className="toast__icon" />}
      <span className="toast__text">{item.text}</span>
      <button
        type="button"
        className="icon-btn icon-btn--small"
        onClick={() => dispatch({ type: 'DISMISS_TOAST', key: item.key })}
        title="Скрыть"
      >
        <IconClose size={12} />
      </button>
    </div>
  )
}

export function ToastStack() {
  const { state } = useDashboard()
  if (state.toasts.length === 0) return null
  return (
    <div className="toasts" aria-live="polite">
      {state.toasts.map(item => (
        <Toast key={item.key} item={item} />
      ))}
    </div>
  )
}
