from app.services import access
from app.services.notify import rules_for
from app.ws.manager import personalize

DEV = {"_id": "u-dev", "role": "developer", "itsmLogin": "alice"}
COORD = {"_id": "u-coord", "role": "coordinator"}


def doc(login=None, members=()):
    return {"data": {"assignedEmployeeLogin": login}, "members": list(members)}


def test_visibility():
    assert access.can_view(COORD, doc("bob"))
    assert access.can_view(DEV, doc("alice"))
    assert access.can_view(DEV, doc("bob", members=["u-dev"]))
    assert not access.can_view(DEV, doc("bob"))
    assert access.mongo_filter(COORD) == {}
    assert {"data.assignedEmployeeLogin": "alice"} in access.mongo_filter(DEV)["$or"]


def env(card, **payload):
    return {"eventId": "e", "type": "incident.updated", "payload": {"incidentId": "INC1", "card": card, **payload}}


def test_ws_personalize():
    mine = {"assignedEmployeeLogin": "alice", "members": []}
    other = {"assignedEmployeeLogin": "bob", "members": []}
    assert personalize(COORD, "incident.updated", env(other)) is not None
    assert personalize(DEV, "incident.updated", env(mine)) is not None
    assert personalize(DEV, "incident.updated", env(other)) is None
    assert personalize(DEV, "import.completed", {"payload": {}}) is None
    # переназначили с alice на bob -> разработчику уходит removed
    moved = personalize(
        DEV, "incident.updated", env(other, changes=[{"field": "assignedEmployeeLogin", "old": "alice", "new": "bob"}])
    )
    assert moved["type"] == "incident.removed" and moved["payload"] == {"incidentId": "INC1"}


def test_developer_rules():
    card = {"assignedEmployeeLogin": "alice", "isActive": True, "productName": "P", "header": "H"}
    created = rules_for("incident.created", {"incidentId": "INC1", "card": card, "groupsEntered": []})
    assert [(n["kind"], n["audience"]) for n in created] == [
        ("incident.assigned_to_me", {"logins": ["alice"]}),
        ("incident.new", None),  # координаторам — как раньше
    ]
    reassigned = rules_for(
        "incident.updated",
        {
            "incidentId": "INC1",
            "card": card,
            "groupsEntered": [],
            "changes": [{"field": "assignedEmployeeLogin", "old": "bob", "new": "alice"}],
        },
    )
    assert [n["kind"] for n in reassigned] == ["incident.assigned_to_me"]
    added = rules_for("incident.members_changed", {"incidentId": "INC1", "card": card, "added": ["u-dev"]})
    assert added[0]["audience"] == {"userIds": ["u-dev"]}
