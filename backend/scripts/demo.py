"""Шпаргалка для живой демонстрации: правит файл с данными так, как это сделал бы человек.

  uv run python -m scripts.demo critical INC000021931582      # сделать критическим (priorityId=4)
  uv run python -m scripts.demo resolve  INC000021931582      # решить (stateId=7, completionDate=now)
  uv run python -m scripts.demo to-coord INC000021938150      # назначить на координаторов
  uv run python -m scripts.demo research INC000021938150      # в «Исследование ситуации»
  uv run python -m scripts.demo deadline INC000021938150 90   # срок через 90 минут
  uv run python -m scripts.demo new-critical                  # добавить новый критический

На защите лучше править файл руками в редакторе — скрипт нужен для репетиций.
"""

import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.core.config import get_settings

FMT = "%Y-%m-%dT%H:%M:%SZ"


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd, args = sys.argv[1], sys.argv[2:]
    s = get_settings()
    path: Path = s.data_file
    records = json.loads(path.read_text(encoding="utf-8"))
    now = datetime.now(UTC)
    by_id = {r["id"]: r for r in records}

    if cmd == "new-critical":
        num = max(int(r["id"][3:]) for r in records) + 1
        base = dict(records[0])
        base.update(
            id=f"INC{num:012d}",
            sysId=str(num),
            submitDate=now.strftime(FMT),
            deadline=(now + timedelta(hours=2)).strftime(FMT),
            completionDate=None,
            stateId=0,
            state="Назначен",
            stateEnum="Assigned",
            priorityId=4,
            priority="Наивысший",
            header=f"Массовый отказ: {base['scenarioName']} ({base['productName']})",
            solution=None,
            assignedGroupName="КЦ ИТ OPS Аварии MSCP",
        )
        records.append(base)
        print("added", base["id"])
    else:
        inc = by_id[args[0]]
        if cmd == "critical":
            inc.update(priorityId=4, priority="Наивысший")
        elif cmd == "resolve":
            inc.update(
                stateId=7,
                state="Завершен",
                stateEnum="Resolved",
                completionDate=now.strftime(FMT),
                stateReason="Постоянное решение",
            )
        elif cmd == "to-coord":
            inc.update(assignedGroupName=s.coordinators_group_name, lastAssignmentToTeamDateTime=now.strftime(FMT))
        elif cmd == "research":
            inc.update(stateId=20, state="Исследование ситуации", stateEnum="Research")
        elif cmd == "deadline":
            inc.update(deadline=(now + timedelta(minutes=int(args[1]))).strftime(FMT))
        else:
            raise SystemExit(f"unknown command {cmd}")
        print(cmd, inc["id"])
    path.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
