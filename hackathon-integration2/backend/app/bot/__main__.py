"""Telegram-бот: uv run python -m app.bot

Бот отвечает только на команды. Уведомления рассылает воркер (services/notify.py) напрямую
через Bot API, поэтому, даже если бот перезапускается, уведомления не теряются.

  /start  — приветствие и кнопка «Войти» (открывает мини-апп)
  /status — к какому пользователю привязан этот чат
  /stop   — отвязать чат и больше не присылать уведомления
"""

import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    BotCommand,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    MenuButtonWebApp,
    Message,
    WebAppInfo,
)
from aiogram.utils.text_decorations import html_decoration as hd

from app.core.config import get_settings
from app.core.logging import setup_logging
from app.db.mongo import close_client
from app.services import telegram

log = logging.getLogger("bot")
dp = Dispatcher()


def mini_app_url() -> str | None:
    base = get_settings().public_base_url
    if not base or not base.startswith("https://"):
        return None
    return base.rstrip("/") + "/tg/app"


def login_keyboard(text: str) -> InlineKeyboardMarkup | None:
    url = mini_app_url()
    if not url:
        return None
    return InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text=text, web_app=WebAppInfo(url=url))]])


NO_URL_HINT = (
    "\n\n⚠️ Кнопка входа недоступна: на сервере не задан PUBLIC_BASE_URL (нужен https-адрес). "
    "Попросите администратора запустить туннель и указать адрес."
)


@dp.message(CommandStart())
async def start(message: Message) -> None:
    user = await telegram.user_by_chat(str(message.chat.id))
    if user:
        text = (
            f"Вы подключены как <b>{hd.quote(user.get('fullName') or user['email'])}</b>.\n"
            "Уведомления о новых инцидентах приходят в этот чат.\n\n/status · /stop"
        )
        kb = login_keyboard("Войти под другим пользователем")
    else:
        text = (
            "Привет! Я присылаю уведомления о новых инцидентах.\n\n"
            "Нажмите «Войти» и введите логин и пароль от дашборда."
        )
        kb = login_keyboard("Войти")
    if kb is None:
        text += NO_URL_HINT
    await message.answer(text, reply_markup=kb)


@dp.message(Command("status"))
async def status(message: Message) -> None:
    user = await telegram.user_by_chat(str(message.chat.id))
    if not user:
        await message.answer("Чат не привязан. Нажмите /start, чтобы войти.")
        return
    kinds = (user.get("notificationSettings") or {}).get("kinds", {})
    off = [k for k, v in kinds.items() if not v]
    extra = f"\nОтключены виды: {', '.join(off)}" if off else ""
    name, email = hd.quote(user.get("fullName") or ""), hd.quote(user["email"])
    await message.answer(f"Привязан к <b>{name}</b> ({email}), роль {user['role']}.{extra}")


@dp.message(Command("stop"))
async def stop(message: Message) -> None:
    count = await telegram.unlink_chat(str(message.chat.id))
    await message.answer("Уведомления отключены. Подключить снова — /start." if count else "Чат и так не привязан.")


@dp.message()
async def fallback(message: Message) -> None:
    await message.answer("Я понимаю команды /start, /status и /stop.")


async def main() -> None:
    s = get_settings()
    setup_logging(s.log_level)
    if not s.telegram_bot_token:
        raise SystemExit("Задайте TELEGRAM_BOT_TOKEN в .env")
    bot = Bot(s.telegram_bot_token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    await bot.set_my_commands(
        [
            BotCommand(command="start", description="Войти / начать"),
            BotCommand(command="status", description="Проверить привязку"),
            BotCommand(command="stop", description="Отключить уведомления"),
        ]
    )
    if url := mini_app_url():
        # кнопка мини-аппа слева от поля ввода
        await bot.set_chat_menu_button(menu_button=MenuButtonWebApp(text="Войти", web_app=WebAppInfo(url=url)))
    me = await bot.get_me()
    log.info("bot started", extra={"extra_data": {"username": me.username, "mini_app": url}})
    try:
        await dp.start_polling(bot)
    finally:
        await close_client()


if __name__ == "__main__":
    asyncio.run(main())
