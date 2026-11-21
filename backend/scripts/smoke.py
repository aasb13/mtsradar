"""Сквозная проверка сценария кейса на живых сервисах (API и воркер должны быть запущены).

    uv run python -m scripts.smoke

ВНИМАНИЕ: правит файл с данными (DATA_FILE). Запускайте на копии:
    DATA_FILE=/tmp/incidents.json  (и с этим же DATA_FILE запущен воркер)
"""

import asyncio
import json
import subprocess
import sys

import httpx
import websockets

from app.core.config import get_settings

API = "http://localhost:8000/api"
DATA_FILE = str(get_settings().data_file)


def demo(*args):
    subprocess.run([sys.executable, "-m", "scripts.demo", *args], check=True, capture_output=True)


async def collect(ws, seconds):
    out = []
    try:
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=seconds))
            out.append(msg)
    except TimeoutError:
        return out


def show(label, msgs):
    print(f"\n=== {label}")
    for m in msgs:
        p = m.get("payload", {})
        if m["type"].startswith("incident."):
            c = p.get("card") or {}
            print(
                f"  {m['type']:<22} {p.get('incidentId')} kinds={p.get('kinds')} entered={p.get('groupsEntered')} left={p.get('groupsLeft')} groups={c.get('groups')} isNewCritical={c.get('isNewCritical')}"
            )
        elif m["type"] == "notification.created":
            print(f"  {m['type']:<22} [{p['kind']}] {p['title']} — {p['body']}")
        else:
            print(f"  {m['type']:<22} {json.dumps(p, ensure_ascii=False)[:160]}")


async def main():
    async with httpx.AsyncClient(base_url=API, timeout=20) as c:
        tok = (await c.post("/auth/login", json={"email": "coord1@example.com", "password": "demo12345"})).json()
        H = {"Authorization": f"Bearer {tok['accessToken']}"}
        d = (await c.get("/dashboard", headers=H)).json()
        print("KPI:", d["kpi"])
        print("groups:", {g: [x["id"] for x in v] for g, v in d["groups"].items()})

        async with websockets.connect(f"ws://localhost:8000/api/ws?token={tok['accessToken']}") as ws:
            print("hello:", json.loads(await ws.recv())["type"])
            demo("critical", "INC000021931151")  # уже на координаторах -> станет и критическим
            show("1) priorityId=4 у инцидента на координаторах", await collect(ws, 3))
            demo("to-coord", "INC000021938150")
            show("2) назначили на координаторов", await collect(ws, 3))
            demo("resolve", "INC000021931151")
            show("3) критический решён", await collect(ws, 3))
            demo("new-critical")
            show("4) новый критический в файле", await collect(ws, 3))
            # битый JSON (сохранили на полпути)
            p = DATA_FILE
            good = open(p, encoding="utf-8").read()
            open(p, "w", encoding="utf-8").write(good[:-50])
            show("5) битый файл", await collect(ws, 3))
            open(p, "w", encoding="utf-8").write(good)
            show("6) файл починили (изменений нет)", await collect(ws, 3))
            demo("deadline", "INC000021938150", "1")  # срок через минуту -> danger
            show("7) срок через 1 минуту (SLA-монитор)", await collect(ws, 8))

            d = (await c.get("/dashboard", headers=H)).json()
            print("\nKPI после:", d["kpi"])
            crit = d["groups"]["critical"]
            print("critical:", [(x["id"], x["isResolved"], x["isNewCritical"], x["sla"]["state"]) for x in crit])
            print("unacknowledged:", d["unacknowledgedCritical"])
            new_id = d["unacknowledgedCritical"][0]
            r = await c.post(f"/incidents/{new_id}/ack", headers=H)
            show("8) координатор подтвердил", await collect(ws, 2))
            print("ack status", r.status_code, r.json()["acknowledged"]["name"])

            # PATCH и переход через API
            r = await c.patch(f"/incidents/{new_id}", headers=H, json={"assignedGroupName": "КЦ ДОИ VMWare"})
            print("PATCH", r.status_code, r.json()["assignedGroupName"])
            r = await c.post(f"/incidents/{new_id}/transition", headers=H, json={"toStateId": 10})
            print("bad transition 0->10:", r.status_code, r.json()["detail"])
            r = await c.post(
                f"/incidents/{new_id}/transition", headers=H, json={"toStateId": 2, "comment": "Взяли в работу"}
            )
            print("transition 0->2:", r.status_code, r.json()["state"], r.json()["data"]["solution"])
            show("9) PATCH + transition", await collect(ws, 2))

            # ИИ-коллега кладёт результат
            r = await c.put(
                f"/internal/incidents/{new_id}/ai",
                headers={"X-Service-Key": "dev-service-key"},
                json={"summary": "Ковёр не взлетает из-за отказа магнитного двигателя.", "riskScore": 82},
            )
            print("AI put:", r.status_code)
            show("10) ИИ-результат", await collect(ws, 2))
            r = await c.put(f"/internal/incidents/{new_id}/ai", json={"summary": "x"})
            print("AI put без ключа:", r.status_code)

            hist = (await c.get(f"/incidents/{new_id}/history", headers=H)).json()
            print("\nhistory:", [(h["type"], h["source"], h["kinds"]) for h in hist])
            notes = (await c.get("/notifications?unreadOnly=true", headers=H)).json()
            print("unread notifications:", notes["unread"], [n["kind"] for n in notes["items"]])

            # права
            vt = (await c.post("/auth/login", json={"email": "viewer@example.com", "password": "demo12345"})).json()[
                "accessToken"
            ]
            r = await c.patch(f"/incidents/{new_id}", headers={"Authorization": f"Bearer {vt}"}, json={"priorityId": 1})
            print("viewer PATCH:", r.status_code)
            # refresh rotation
            r1 = await c.post("/auth/refresh", json={"refreshToken": tok["refreshToken"]})
            r2 = await c.post("/auth/refresh", json={"refreshToken": tok["refreshToken"]})
            print("refresh:", r1.status_code, "reuse:", r2.status_code)
            # экспорт -> импорт dry-run = без изменений
            ex = await c.get("/export", headers=H)
            files = {"file": ("x.json", ex.content, "application/json")}
            r = await c.post("/import?dryRun=true", headers=H, files=files)
            rep = r.json()
            print(
                "export->import dryRun:",
                {k: rep[k] for k in ("total", "created", "updated", "unchanged", "archived")},
                "errors",
                rep["errors"],
            )
            board = (await c.get("/board", headers=H)).json()
            print("board:", [(col["title"], col["count"]) for col in board["columns"]])
            st = (await c.get("/stats", headers=H)).json()
            print("stats resolved:", st["resolved"])


if __name__ == "__main__":
    asyncio.run(main())
