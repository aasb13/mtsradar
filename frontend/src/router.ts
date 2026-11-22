import { useEffect, useState } from 'react'

/**
 * Минимальный hash-роутер без зависимостей. Путь вида #/kanban;
 * navigate() дописывает историю браузера, replace() заменяет запись.
 * Query части (#/chat?s=…) отделяются от пути: useRoute видит только путь.
 */

export function currentPath(): string {
  const raw = window.location.hash.replace(/^#/, '')
  const path = raw.split('?')[0]
  return path === '' ? '/' : path
}

/** Query из hash-пути (#/chat?s=ID) — для экранов, которые открывают с параметром. */
export function routeQuery(): URLSearchParams {
  const raw = window.location.hash.replace(/^#/, '')
  const idx = raw.indexOf('?')
  return new URLSearchParams(idx === -1 ? '' : raw.slice(idx + 1))
}

export function navigate(path: string, replace = false): void {
  const target = `#${path}`
  if (window.location.hash === target) return
  if (replace) {
    const url = `${window.location.pathname}${window.location.search}${target}`
    window.history.replaceState(null, '', url)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else {
    window.location.hash = target
  }
}

export function useRoute(): string {
  const [path, setPath] = useState(currentPath)
  useEffect(() => {
    const onChange = () => setPath(currentPath())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return path
}
