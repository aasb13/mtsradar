import { useEffect, useState } from 'react'

/**
 * Минимальный hash-роутер без зависимостей. Путь вида #/kanban;
 * navigate() дописывает историю браузера, replace() заменяет запись.
 */

export function currentPath(): string {
  const raw = window.location.hash.replace(/^#/, '')
  return raw === '' ? '/' : raw
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
