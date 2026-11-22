#!/bin/sh
# Деплой из workspace Forgejo Actions на этот же хост (раннер с меткой mtsradar:host
# работает на машине деплоя). Стек нативный, без контейнеров: mongod, redis, rabbitmq —
# свои systemd-юниты; код синхронизируется в /srv/mtsradar, пересобираются зависимости
# и перезапускаются два процесса приложения: api (uvicorn) и worker (вотчер файла).
# backend/.env не перезаписывается: секреты создаются на таргете один раз.
set -eu

SRC="${MTSRADAR_SRC:-$(cd "$(dirname "$0")/.." && pwd)}"
DST=/srv/mtsradar

if [ ! -f "$DST/backend/.env" ]; then
    echo "нет $DST/backend/.env — создайте его один раз на таргете (шаблон: backend/.env.example)" >&2
    exit 1
fi

rsync -a --delete \
    --exclude ".git" \
    --exclude "backend/.env" \
    --exclude "backend/.venv" \
    --exclude "node_modules" \
    --exclude "frontend/dist" \
    "$SRC/" "$DST/"

cd "$DST"

# зависимости и сборка (node_modules/.venv живут только на таргете, в репозитории их нет);
# фронт отдаётся production-сборкой (mtsradar-frontend = vite preview), не dev-сервером
cd frontend && npm install --no-audit --no-fund && npm run build && cd ..
cd backend && uv sync --frozen --no-dev && cd ..

# перезапуск двух процессов приложения (с sudo-правом для runner, см. sudoers.d/mtsradar-deploy)
sudo -n systemctl restart mtsradar-api
sudo -n systemctl restart mtsradar-worker
sudo -n systemctl restart mtsradar-frontend

# готовность API проверяем через фронтовый прокси
curl -fsS --retry 15 --retry-delay 2 --retry-connrefused --max-time 20 http://127.0.0.1:3101/api/health
echo
echo "deploy ok"
