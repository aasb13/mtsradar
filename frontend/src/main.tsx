import '@fontsource-variable/inter'
import './styles.css'
import './responsive.css'
import './screen.css'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './screens/error'

const root = document.getElementById('root')
if (root === null) throw new Error('Не найден корневой элемент #root')

createRoot(root).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
