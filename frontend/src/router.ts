import { useEffect, useState } from 'react'

/**
 * Минимальный history-роутер без зависимостей: пути вида /kanban меняются через
 * History API. navigate() дописывает историю браузера, replace() заменяет запись;
 * оба сами диспатчат popstate, т.к. pushState/replaceState его не создают.
 * Query части (/chat?s=…) отделяются от пути: useRoute видит только путь.
 */

export function currentPath(): string {
  return window.location.pathname
}

/** Query из URL (/chat?s=ID) — для экранов, которые открывают с параметром. */
export function routeQuery(): URLSearchParams {
  return new URLSearchParams(window.location.search)
}

const INCIDENT_PREFIX = '/incident/'
const NEXT_PARAM = 'next'

/** Адрес карточки инцидента: ссылку можно отправить коллеге или открыть в новой вкладке. */
export function incidentPath(id: string): string {
  return `${INCIDENT_PREFIX}${encodeURIComponent(id)}`
}

/** ID инцидента из адреса /incident/<id>; null, если это другой путь. */
export function incidentIdFromPath(path: string): string | null {
  if (!path.startsWith(INCIDENT_PREFIX)) return null
  const raw = path.slice(INCIDENT_PREFIX.length)
  if (raw === '' || raw.includes('/')) return null
  try {
    return decodeURIComponent(raw)
  } catch (err) {
    console.error('Некорректный номер инцидента в адресе', err)
    return null
  }
}

/** Адрес инцидента, сохранённый при входе по ссылке (/login?next=…). */
export function nextIncidentPath(): string | null {
  const next = routeQuery().get(NEXT_PARAM)
  return next !== null && incidentIdFromPath(next) !== null ? next : null
}

export function loginPath(next: string): string {
  return `/login?${NEXT_PARAM}=${encodeURIComponent(next)}`
}

export function navigate(path: string, replace = false, state: unknown = null): void {
  const target = path.startsWith('/') ? path : `/${path}`
  if (`${window.location.pathname}${window.location.search}` === target) return
  if (replace) {
    window.history.replaceState(state, '', target)
  } else {
    window.history.pushState(state, '', target)
  }
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/** Экран, с которого открыли карточку: сюда возвращаем пользователя при закрытии. */
export function incidentReturnPath(): string | null {
  const state = window.history.state as { radarReturn?: unknown } | null
  return typeof state?.radarReturn === 'string' && state.radarReturn.startsWith('/') ? state.radarReturn : null
}

export function useRoute(): string {
  const [path, setPath] = useState(currentPath)
  useEffect(() => {
    const onChange = () => setPath(currentPath())
    window.addEventListener('popstate', onChange)
    return () => window.removeEventListener('popstate', onChange)
  }, [])
  return path
}
