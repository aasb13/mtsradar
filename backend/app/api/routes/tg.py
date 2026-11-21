"""Telegram: страница мини-аппа (/tg/app) и привязка аккаунта (/api/tg/...).

Мини-апп входит по тем же логину и паролю, что и сайт: используется та же проверка
(_authenticate) и то же ограничение попыток (_rate_limit).
"""

from html import escape
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from app.api.deps import CurrentUser
from app.api.routes.auth import _authenticate, _rate_limit
from app.core.config import get_settings
from app.db.mongo import get_db
from app.services import telegram
from app.services.users import public_user

page_router = APIRouter(prefix="/tg", include_in_schema=False)
api_router = APIRouter(prefix="/tg", tags=["telegram"])


class LinkIn(BaseModel):
    initData: str
    email: str
    password: str


@api_router.post("/link", dependencies=[Depends(_rate_limit)])
async def link_telegram(body: LinkIn) -> dict[str, Any]:
    """Вызывается мини-аппом: проверяем подпись Telegram и пароль, привязываем чат."""
    s = get_settings()
    if not s.telegram_bot_token:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Telegram-бот не настроен (TELEGRAM_BOT_TOKEN)")
    try:
        tg_user = telegram.verify_init_data(body.initData, s.telegram_bot_token, s.telegram_init_data_max_age_sec)
    except telegram.InitDataError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(e)) from e
    user = await _authenticate(body.email, body.password)
    await telegram.link(user["_id"], tg_user)
    await telegram.send_message(
        str(tg_user["id"]),
        f"✅ Готово, <b>{escape(user.get('fullName') or user['email'])}</b>!\n"
        "Теперь сюда будут приходить уведомления о новых инцидентах.\n"
        "/status — проверить привязку, /stop — отключить.",
    )
    fresh = await get_db().users.find_one({"_id": user["_id"]})
    return {"ok": True, "user": public_user(fresh)}


@api_router.post("/unlink")
async def unlink_telegram(user: CurrentUser) -> dict[str, Any]:
    """Отвязать Telegram с сайта (например, кнопкой в профиле)."""
    chat_id = user.get("telegramChatId")
    if chat_id:
        await telegram.unlink_chat(chat_id)
        await telegram.send_message(chat_id, "Уведомления отключены с сайта. Подключить снова — /start.")
    return {"ok": True}


MINI_APP_HTML = """<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Вход</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
*{box-sizing:border-box}
body{margin:0;padding:24px 20px;font:15px/1.45 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;
background:var(--tg-theme-bg-color,#fff);color:var(--tg-theme-text-color,#111)}
h1{font-size:20px;margin:0 0 6px;font-weight:600}
p{margin:0 0 20px;color:var(--tg-theme-hint-color,#777)}
label{display:block;font-size:13px;color:var(--tg-theme-hint-color,#777);margin:14px 0 6px}
input{width:100%;padding:12px;border-radius:10px;border:1px solid var(--tg-theme-hint-color,#ccc);
font:inherit;background:var(--tg-theme-secondary-bg-color,#f4f4f5);color:inherit}
button{width:100%;margin-top:22px;padding:13px;border:0;border-radius:10px;font:inherit;font-weight:600;
background:var(--tg-theme-button-color,#2481cc);color:var(--tg-theme-button-text-color,#fff)}
button:disabled{opacity:.6}
.msg{margin-top:16px;padding:12px;border-radius:10px;display:none}
.err{display:block;background:#fde2e1;color:#8a0a10}.ok{display:block;background:#e3f6e8;color:#145c2a}
</style></head><body>
<h1>Вход в дашборд инцидентов</h1>
<p>Используйте те же логин и пароль, что и на сайте. После входа бот будет присылать уведомления.</p>
<form id="f">
  <label for="email">Логин (email)</label>
  <input id="email" type="email" autocomplete="username" required placeholder="name@example.com">
  <label for="password">Пароль</label>
  <input id="password" type="password" autocomplete="current-password" required>
  <button id="btn" type="submit">Войти</button>
</form>
<div id="msg" class="msg"></div>
<script>
const tg = window.Telegram && window.Telegram.WebApp;
const msg = document.getElementById("msg"), btn = document.getElementById("btn");
function show(text, cls) { msg.textContent = text; msg.className = "msg " + cls; }
if (tg) { tg.ready(); tg.expand(); }
if (!tg || !tg.initData) { show("Откройте эту страницу кнопкой «Войти» в Telegram-боте.", "err"); btn.disabled = true; }
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  btn.disabled = true; btn.textContent = "Проверяем…"; msg.className = "msg";
  try {
    const r = await fetch("/api/tg/link", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({initData: tg.initData,
        email: document.getElementById("email").value.trim(),
        password: document.getElementById("password").value})
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Не удалось войти");
    show("Готово, " + (data.user.fullName || data.user.email) + "! Возвращаемся в чат…", "ok");
    if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
    setTimeout(() => tg.close(), 1200);
  } catch (err) {
    show(err.message, "err");
    if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("error");
    btn.disabled = false; btn.textContent = "Войти";
  }
});
</script></body></html>"""


@page_router.get("/app", response_class=HTMLResponse)
async def mini_app() -> HTMLResponse:
    return HTMLResponse(MINI_APP_HTML)
