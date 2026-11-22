import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
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
      // 8001, а не 8000: на демо-сервере порт 8000 занят чужим процессом
      '/api': { target: 'http://127.0.0.1:8001', changeOrigin: true, ws: true },
      // ITSM-муляж и страницы Telegram-мини-аппа живут в том же бэкенде
      '/itsm': { target: 'http://127.0.0.1:8001', changeOrigin: true },
      '/tg': { target: 'http://127.0.0.1:8001', changeOrigin: true },
    },
  },
})
