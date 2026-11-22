import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { AppProvider, useApp } from './store'
import { Header, ToastStack } from './screens/shell'
import { LoginPage, PendingPage, RegisterPage } from './screens/auth'
import { KanbanPage } from './screens/kanban'
import { AttentionPage } from './screens/attention'
import { StatsPage } from './screens/stats'
import { ChatPage } from './screens/chat'
import { AdminDonePage, AdminIncidentsPage, AdminProductsPage, AdminTeamsPage, AdminUsersPage } from './screens/admin'
import { DevPage, QaPage } from './screens/work'
import { AssignModal, FreezeModal, IncidentPanel } from './screens/panel'
import { navigate, useRoute } from './router'
import type { Role } from './types'

const HOME_BY_ROLE: Record<Role, string> = {
  coordinator: '/',
  admin: '/',
  developer: '/dev',
  viewer: '/qa',
}

function Splash() {
  return (
    <div className="splash">
      <p className="splash__text">Загрузка…</p>
    </div>
  )
}

function Screens() {
  const { state, dispatch } = useApp()
  const route = useRoute()

  // неавторизованный — на вход; авторизованный — на свой главный экран
  useEffect(() => {
    if (state.user === null) {
      if (route !== '/login' && route !== '/register' && route !== '/pending') navigate('/login', true)
      return
    }
    if (route === '/login' || route === '/register' || route === '/pending') {
      navigate(HOME_BY_ROLE[state.user.role], true)
    }
  }, [state.user, route])

  // Esc закрывает панель инцидента
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state.panelId !== null) {
        dispatch({ type: 'OPEN_PANEL', id: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.panelId, dispatch])

  if (state.user === null) {
    // сессия ещё проверяется — не показываем логин, чтобы страница не мигала
    if (state.authChecking) return <Splash />
    if (route === '/register') return <RegisterPage />
    if (route === '/pending') return <PendingPage />
    return <LoginPage />
  }

  const user = state.user
  const isStaff = user.role === 'coordinator' || user.role === 'admin'

  let screen: ReactNode
  switch (route) {
    case '/':
      screen = isStaff ? <KanbanPage /> : user.role === 'developer' ? <DevPage /> : <QaPage />
      break
    case '/attention':
      screen = <AttentionPage />
      break
    case '/stats':
      screen = <StatsPage />
      break
    case '/chat':
      screen = <ChatPage />
      break
    case '/admin':
      screen = <AdminIncidentsPage />
      break
    case '/admin/products':
      screen = <AdminProductsPage />
      break
    case '/admin/teams':
      screen = <AdminTeamsPage />
      break
    case '/admin/users':
      screen = <AdminUsersPage />
      break
    case '/admin/done':
      screen = <AdminDonePage />
      break
    case '/dev':
      screen = <DevPage />
      break
    case '/qa':
      screen = <QaPage />
      break
    default:
      screen =
        user.role === 'developer' ? (
          <DevPage />
        ) : user.role === 'viewer' ? (
          <QaPage />
        ) : (
          <KanbanPage />
        )
  }

  return (
    <div className="app">
      <Header />
      <main className="page">{screen}</main>
      {isStaff && <IncidentPanel />}
      {isStaff && <AssignModal />}
      {isStaff && <FreezeModal />}
      <ToastStack />
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      <Screens />
    </AppProvider>
  )
}
