import { useDashboard } from '../store'
import { IconClose } from './Icons'

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Ctrl + K', action: 'Фокус в поиск по инцидентам' },
  { keys: 'Esc', action: 'Закрыть панель инцидента, справку или баннер критических' },
  { keys: '?', action: 'Открыть эту справку' },
  { keys: '1 – 4', action: 'Перейти к группе инцидентов' },
]

export function ShortcutsModal() {
  const { state, dispatch } = useDashboard()
  if (!state.shortcutsOpen) return null
  return (
    <div className="modal-backdrop" onClick={() => dispatch({ type: 'TOGGLE_SHORTCUTS' })}>
      <div className="modal" role="dialog" aria-label="Горячие клавиши" onClick={e => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">Горячие клавиши</h2>
          <button type="button" className="icon-btn" onClick={() => dispatch({ type: 'TOGGLE_SHORTCUTS' })} title="Закрыть">
            <IconClose size={16} />
          </button>
        </div>
        <div className="modal__list">
          {SHORTCUTS.map(item => (
            <div key={item.keys} className="modal__row">
              <span className="modal__keys">
                <kbd>{item.keys}</kbd>
              </span>
              <span className="modal__action">{item.action}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
