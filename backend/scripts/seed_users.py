"""Демо-пользователи: uv run python -m scripts.seed_users

Создаёт (если их ещё нет) админа, трёх координаторов, наблюдателя и двух разработчиков,
пароль у всех — demo12345. У разработчиков itsmLogin совпадает с assignedEmployeeLogin в данных,
поэтому они сразу видят «свои» инциденты.
"""

import asyncio

from app.core.config import get_settings
from app.db.mongo import close_client, ensure_indexes, get_db
from app.domain.enums import Role
from app.services.users import create_user

USERS = [
    ("coord1@example.com", "Анна Координатор", Role.COORDINATOR),
    ("coord2@example.com", "Борис Координатор", Role.COORDINATOR),
    ("coord3@example.com", "Вера Координатор", Role.COORDINATOR),
    ("viewer@example.com", "Наблюдатель", Role.VIEWER),
]
DEVELOPERS = [
    ("alice@example.com", "Алиса в Стране Чудес", "alice"),
    ("winnie@example.com", "Винни Пух", "winnie"),
]


async def main() -> None:
    await ensure_indexes()
    s = get_settings()
    users = get_db().users
    if not await users.find_one({"email": s.bootstrap_admin_email}):
        await create_user(s.bootstrap_admin_email, s.bootstrap_admin_password, "Администратор", Role.ADMIN)
        print("created", s.bootstrap_admin_email)
    for email, name, role in USERS:
        if not await users.find_one({"email": email}):
            await create_user(email, "demo12345", name, role)
            print("created", email)
    for email, name, login in DEVELOPERS:
        if not await users.find_one({"email": email}):
            await create_user(email, "demo12345", name, Role.DEVELOPER, itsm_login=login)
            print("created developer", email, "->", login)
    await close_client()


if __name__ == "__main__":
    asyncio.run(main())
