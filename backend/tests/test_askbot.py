"""Check the ask-questions bot with no AI key: order IDs found by pattern, never a whole sentence saved as the ID.
WhatsApp and the database are faked, so this needs neither.

    cd backend
    .venv/Scripts/python.exe tests/test_askbot.py
"""
import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
load_dotenv(BACKEND / ".env")
os.environ["ANTHROPIC_API_KEY"] = ""
import server  # noqa: E402

state = {}
sent = []
saved = []


class FakeDB:
    async def fetchrow(self, q, *a):
        return {"step": 0, "fields": state.get("fields", {})} if "FROM wa_conversations" in q and "fields" in state else None

    async def execute(self, q, *a):
        if q.strip().startswith("INSERT INTO wa_conversations") or "UPSERT" in q or "wa_conversations" in q and "INSERT" in q:
            state["fields"] = dict(a[3])
        if q.startswith("DELETE FROM wa_conversations"):
            state.pop("fields", None)
        return "OK"


server.db = lambda: FakeDB()
server.ai_ready = lambda: False


async def fake_send(cfg, to, text, source="bot"):
    sent.append(text)


async def fake_insert(data):
    saved.append(data)
    return {"order_id": data["order_id"], "product_name": data["product_name"], "charm": data["charm"], "notes": data["notes"]}


server.send_wa = fake_send
server.insert_order = fake_insert
cfg = {"logical_id": "Order desk"}


async def run(msgs):
    state.clear(); sent.clear(); saved.clear()
    for m in msgs:
        await server.handle_bot_message(cfg, "918429172126", m)
    return list(sent), dict(state.get("fields", {})), list(saved)


s, f, _ = asyncio.run(run(["Hi", "Hi, my order is 123456789012_1, name AARAV, heart charm"]))
print("long message ->", f, "| bot asked:", s[-1])
assert f.get("order_id") == "123456789012_1", f
s, f, _ = asyncio.run(run(["Hi", "ok"]))
print("'ok' ->", f, "| bot asked:", s[-1])
assert not f.get("order_id")
s, f, done = asyncio.run(run(["Hi", "OD432198765432109876", "Meera", "star", "none"]))
print("step by step ->", done[0]["order_id"], done[0]["product_name"], done[0]["charm"], "| phone:", done[0].get("customer_phone"))
assert done and done[0]["order_id"] == "OD432198765432109876" and done[0]["customer_phone"] == "918429172126"
print("ALL OK")
