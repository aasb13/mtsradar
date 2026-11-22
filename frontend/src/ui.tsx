import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, KeyboardEvent as ReactKeyboardEvent, ReactNode, TextareaHTMLAttributes } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { initials, isUnassigned, liveSla, priorityMeta } from './format'
import type { Card } from './types'

// ---------------- кнопки ----------------

export function Button({
  variant = 'secondary',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'violet' | 'danger' | 'danger-light' | 'freeze' }) {
  return (
    <button type="button" className={`btn btn--${variant} ${className}`} {...rest}>
      {children}
    </button>
  )
}

// ---------------- бейджи приоритета ----------------

export function SeverityBadge({ priorityId }: { priorityId: number }) {
  const meta = priorityMeta(priorityId)
  return (
    <span className={`sev sev--${meta.tone}`}>
      <span className="sev__dot" />
      {meta.label}
    </span>
  )
}

// ---------------- пилюли статуса ----------------

const PILL_TEXT: Record<number, string> = {
  0: 'К выполнению',
  2: 'В работе',
  7: 'На проверке',
  10: 'Закрыт',
  20: 'Исследование',
}

export function StatusPill({
  card,
  className = '',
}: {
  card: Pick<Card, 'stateId' | 'assignedGroupName'>
  className?: string
}) {
  const stateId = card.stateId
  const tone = stateId === 0 || stateId === 20 ? 'todo' : stateId === 2 ? 'work' : stateId === 7 ? 'review' : 'done'
  return (
    <span className={`pill pill--${tone} ${className}`}>
      <span className="pill__dot" />
      {isUnassigned(card) ? 'Не назначено' : PILL_TEXT[stateId] ?? `Статус ${stateId}`}
    </span>
  )
}

// ---------------- SLA-чип ----------------

export function SlaChip({ card, now, frozen }: { card: Card; now: number; frozen?: boolean }) {
  const sla = liveSla(card, now)
  if (frozen) {
    return (
      <span className="slachip slachip--frozen">
        <SnowflakeIcon />
        Пауза
      </span>
    )
  }
  const tone =
    sla.state === 'breach'
      ? 'breach'
      : sla.state === 'danger'
        ? 'breach'
        : sla.state === 'warning'
          ? 'warn'
          : sla.state === 'resolved'
            ? 'done'
            : sla.state === 'none'
              ? 'none'
              : 'ok'
  const icon = sla.state === 'breach' ? <AlertIcon /> : sla.state === 'resolved' ? <CheckCircleIcon /> : <ClockIcon />
  return (
    <span className={`slachip slachip--${tone}`}>
      {icon}
      {sla.label}
    </span>
  )
}

// ---------------- аватар ----------------

export function Avatar({ name, size = 'md', tone = 'blue' }: { name?: string | null | undefined; size?: 'sm' | 'md' | 'lg' | 'xl'; tone?: 'blue' | 'violet' | 'ghost' }) {
  if (tone === 'ghost') {
    return (
      <span className={`avatar avatar--${size} avatar--ghost`}>
        <UserIcon />
      </span>
    )
  }
  return <span className={`avatar avatar--${size} avatar--${tone}`}>{initials(name)}</span>
}

// ---------------- поля формы ----------------

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {error !== null && error !== undefined && <span className="field__error">{error}</span>}
      {error === null && hint !== undefined && <span className="field__hint">{hint}</span>}
    </label>
  )
}

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input ${className}`} {...rest} />
}

export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`input input--area ${className}`} {...rest} />
}

export interface SelectOption<V extends string = string> {
  value: V
  label: string
}

export function stringOptions(values: string[]): SelectOption[] {
  return values.map(v => ({ value: v, label: v }))
}

// порог числа пунктов, с которого в выпадашке появляется поиск
export const SEARCH_MIN_OPTIONS = 15

// нечёткое совпадение: все символы запроса встречаются в тексте по порядку
export function fuzzyMatch(query: string, text: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const t = text.toLowerCase()
  let i = 0
  for (const ch of q) {
    i = t.indexOf(ch, i)
    if (i === -1) return false
    i++
  }
  return true
}

export function Select<V extends string>({
  value,
  options,
  onChange,
  className = '',
  style,
}: {
  value: V
  options: SelectOption<V>[]
  onChange: (value: V) => void
  className?: string
  style?: CSSProperties
}) {
  const [open, setOpen] = useState(false)
  const [hl, setHl] = useState(0)
  const [query, setQuery] = useState('')
  const id = useId()
  const ref = useRef<HTMLSpanElement>(null)
  const hlRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const selectedIdx = options.findIndex(o => o.value === value)
  const searchable = options.length >= SEARCH_MIN_OPTIONS
  const visible = searchable ? options.filter(o => fuzzyMatch(query, o.label)) : options

  useEffect(() => {
    if (!open) return
    // Escape должен закрыть только меню, а не модальное окно под ним
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      } else if (e.key === 'Tab') {
        setOpen(false)
      }
    }
    const onDown = (e: PointerEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  useEffect(() => {
    if (open) hlRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open, hl])

  useEffect(() => {
    if (open && searchable) searchRef.current?.focus()
  }, [open, searchable])

  const pick = (v: V) => {
    setOpen(false)
    onChange(v)
  }

  const openMenu = () => {
    setQuery('')
    setHl(Math.max(0, selectedIdx))
    setOpen(true)
  }

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (visible.length === 0) return
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setHl(h => (h + delta + visible.length) % visible.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setHl(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setHl(Math.max(0, visible.length - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const o = visible[hl]
      if (o !== undefined) pick(o.value)
    }
  }

  const onTriggerKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        openMenu()
      }
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setHl(h => (h + delta + options.length) % options.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setHl(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setHl(options.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const o = options[hl]
      if (o !== undefined) pick(o.value)
    }
  }

  return (
    <span className={`select ${className}`} style={style} ref={ref}>
      <button
        type="button"
        className="select__trigger"
        disabled={options.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-activedescendant={open ? `${id}-opt${hl}` : undefined}
        onClick={() => {
          if (!open) openMenu()
          else setOpen(false)
        }}
        onKeyDown={onTriggerKey}
      >
        <span className="select__value">{options[selectedIdx]?.label ?? '—'}</span>
        <span className="select__chev">
          <ChevronDownIcon size={15} />
        </span>
      </button>
      {open && (
        <span className={`select-menu${searchable ? ' select-menu--search' : ''}`}>
          {searchable && (
            <input
              ref={searchRef}
              className="select-menu__search"
              type="text"
              placeholder="Поиск…"
              value={query}
              onChange={e => {
                setQuery(e.target.value)
                setHl(0)
              }}
              onKeyDown={onSearchKey}
            />
          )}
          <span className="select-menu__list" role="listbox">
            {visible.map((o, i) => (
              <button
                key={o.value}
                ref={i === hl ? hlRef : undefined}
                type="button"
                role="option"
                id={`${id}-opt${i}`}
                aria-selected={o.value === value}
                className={`select__opt${i === hl ? ' select__opt--hl' : ''}${o.value === value ? ' select__opt--sel' : ''}`}
                onMouseEnter={() => setHl(i)}
                onClick={() => pick(o.value)}
              >
                {o.label}
              </button>
            ))}
          </span>
          {visible.length === 0 && <span className="select-menu__empty">Ничего не найдено</span>}
        </span>
      )}
    </span>
  )
}

// ---------------- модальное окно ----------------

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 720,
}: {
  title: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  // пока модалка открыта, страница под ней не прокручивается; паддинг компенсирует исчезнувший скроллбар
  useEffect(() => {
    const scrollbar = window.innerWidth - document.documentElement.clientWidth
    const prevOverflow = document.body.style.overflow
    const prevPadding = document.body.style.paddingRight
    document.body.style.overflow = 'hidden'
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`
    return () => {
      document.body.style.overflow = prevOverflow
      document.body.style.paddingRight = prevPadding
    }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="overlay overlay--center" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: width }} ref={ref}>
        <div className="modal__head">
          <div>
            <h2 className="modal__title">{title}</h2>
            {subtitle !== undefined && <p className="modal__subtitle">{subtitle}</p>}
          </div>
          <button type="button" className="iconbtn" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer !== undefined && <div className="modal__foot">{footer}</div>}
      </div>
    </div>
  )
}

// ---------------- фильтр-чип ----------------

export function FilterChip({ label, value, active = false, children }: { label: string; value: string; active?: boolean; children: ReactNode }) {
  return (
    <span className={`fchip ${active ? 'fchip--active' : ''}`}>
      <span className="fchip__label">{label}</span>
      <span className="fchip__value">{value}</span>
      <ChevronDownIcon />
      {children}
    </span>
  )
}

// ---------------- вкладки ----------------

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: ReactNode }[]; value: T; onChange: (key: T) => void }) {
  return (
    <div className="tabs">
      {tabs.map(tab => (
        <button key={tab.key} type="button" className={`tabs__tab ${tab.key === value ? 'tabs__tab--active' : ''}`} onClick={() => onChange(tab.key)}>
          {tab.label}
        </button>
      ))}
    </div>
  )
}

// ---------------- пустое состояние ----------------

export function EmptyState({ title, note }: { title: string; note?: string }) {
  return (
    <div className="empty">
      <span className="empty__icon">
        <InboxIcon />
      </span>
      <p className="empty__title">{title}</p>
      {note !== undefined && <p className="empty__note">{note}</p>}
    </div>
  )
}

// ---------------- markdown (ответы BigDad) ----------------

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

/** Markdown от BigDad: GFM (таблицы, чек-листы), ссылки в новой вкладке. Сырой HTML не рендерится. */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

// ---------------- иконки (Lucide-стиль, stroke 1.5) ----------------

interface IconProps {
  size?: number
}

function svg(size: number | undefined, children: ReactNode) {
  return (
    <svg width={size ?? 16} height={size ?? 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

export function Spinner({ size = 18 }: IconProps) {
  return (
    <svg
      className="spinner"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" strokeOpacity="0.25" />
      <path d="M12 3a9 9 0 0 1 9 9" />
    </svg>
  )
}

export function SearchIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </>
  ))
}

export function BellIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
    </>
  ))
}

export function StatsIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <path d="M3 3v18h18" />
      <path d="M7 15v-4M12 15V7M17 15v-6" />
    </>
  ))
}

export function UserIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M5 21c0-4 3-6 7-6s7 2 7 6" />
    </>
  ))
}

export function UsersIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20c0-3.5 2.7-5.5 6-5.5s6 2 6 5.5" />
      <circle cx="17" cy="9" r="3" />
      <path d="M16.5 14.5c2.8.3 4.5 2 4.5 4.5" />
    </>
  ))
}

export function ClockIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ))
}

export function CheckCircleIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ))
}

export function CheckIcon({ size }: IconProps) {
  return svg(size, <path d="m5 12.5 4.5 4.5L19 7.5" />)
}

export function AlertIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 10v4M12 17.2v.1" />
    </>
  ))
}

export function CloseIcon({ size }: IconProps) {
  return svg(size, <path d="M6 6l12 12M18 6 6 18" />)
}

export function ChevronDownIcon({ size }: IconProps) {
  return svg(size, <path d="m6 9 6 6 6-6" />)
}

export function EyeIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ))
}

export function LinkIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1.5 1.5" />
      <path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6L12.5 17.5" />
    </>
  ))
}

export function SnowflakeIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <path d="M12 2v20M4.5 6.5l15 11M19.5 6.5l-15 11" />
      <path d="M12 5.5 10 4M12 5.5 14 4M12 18.5l-2 1.5M12 18.5l2 1.5M6 10 4.5 8M6 10l-2.2.5M18 14l2.2-.5M18 14l-1.5 2M18 10l1.5-2M18 10l2.2.5M6 14l-2.2-.5M6 14l1.5 2" />
    </>
  ))
}

export function SparkIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <path d="M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16.4l-1.8-4.9L5 9.7l5.2-1.8L12 3Z" />
      <path d="M19 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z" />
    </>
  ))
}

export function RefreshIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <path d="M21 3v6h-6" />
    </>
  ))
}

export function InboxIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <path d="M3 13h5l2 3h4l2-3h5" />
      <path d="M5 5h14l2 8v6H3v-6l2-8Z" />
    </>
  ))
}

export function UploadIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </>
  ))
}

export function DownloadIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <path d="M12 4v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </>
  ))
}

export function FileIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <path d="M6 3h8l4 4v14H6V3Z" />
      <path d="M14 3v4h4" />
    </>
  ))
}

export function TrashIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5h6v2" />
      <path d="M6 7l1 13h10l1-13" />
    </>
  ))
}

export function PlusIcon({ size }: IconProps) {
  return svg(size, <path d="M12 5v14M5 12h14" />)
}

export function DotsIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </>
  ))
}

export function SendIcon({ size }: IconProps) {
  return svg(size, <path d="M21 3 10.5 13.5M21 3l-7 18-3.5-7.5L3 10l18-7Z" />)
}

export function UndoIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <path d="M8 5H14a6 6 0 1 1 0 12H6" />
      <path d="m10 3-4 2 4 2" transform="translate(0 2)" />
    </>
  ))
}

export function LogoutIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <path d="M14 4h5v16h-5" />
      <path d="M10 8l-4 4 4 4M6 12h11" />
    </>
  ))
}

export function CommentIcon({ size }: IconProps) {
  return svg(size, <path d="M4 5h16v11H9l-5 4V5Z" />)
}

export function TeamIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <circle cx="12" cy="7" r="3.5" />
      <path d="M5 21c0-3.8 3-6 7-6s7 2.2 7 6" />
    </>
  ))
}

export function BoxIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
      <path d="M4 7l8 4 8-4M12 11v10" />
    </>
  ))
}

export function StarIcon({ size }: IconProps) {
  return svg(size, <path d="m12 4 2.2 4.9 5.3.6-3.9 3.6 1 5.2L12 15.6l-4.6 2.7 1-5.2L4.5 9.5l5.3-.6L12 4Z" />)
}

export function MailIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ))
}

export function SunIcon({ size }: IconProps) {
  return svg(size, (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ))
}

export function MoonIcon({ size }: IconProps) {
  return svg(size, <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" />)
}

export function ArrowRightIcon({ size }: IconProps) {
  return svg(size, <path d="M4 12h16m-6-6 6 6-6 6" />)
}
