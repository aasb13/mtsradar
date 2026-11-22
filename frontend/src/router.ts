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

export function navigate(path: string, replace = false): void {
  const target = path.startsWith('/') ? path : `/${path}`
  if (`${window.location.pathname}${window.location.search}` === target) return
  if (replace) {
    window.history.replaceState(null, '', target)
  } else {
    window.history.pushState(null, '', target)
  }
  window.dispatchEvent(new PopStateEvent('popstate'))
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
