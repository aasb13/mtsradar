import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // Один бэкенд для веба и мобильного приложения. По умолчанию — локальный API
  // на 8000 (как в README и docker-compose). На демо-сервере, где 8000 занят,
  // адрес переопределяется переменной VITE_API_TARGET.
  const env = loadEnv(mode, '.', '')
  const apiTarget = env.VITE_API_TARGET || 'http://127.0.0.1:8000'

  return {
    plugins: [react()],
    server: {
      // ::1 is unreachable on this machine (IPv6 loopback drops traffic);
      // bind all interfaces so 127.0.0.1 works
      host: true,
      port: 5173,
      // демо-сервер: фронт отдаётся через cauterp с Host: mtsradar.mooo.com
      allowedHosts: ['mtsradar.mooo.com'],
      proxy: {
        // 127.0.0.1, а не localhost: на части машин localhost резолвится в ::1, где бэкенда нет.
        '/api': { target: apiTarget, changeOrigin: true, ws: true },
        // ITSM-муляж и страницы Telegram-мини-аппа живут в том же бэкенде
        '/itsm': { target: apiTarget, changeOrigin: true },
        '/tg': { target: apiTarget, changeOrigin: true },
      },
    },
  }
})
