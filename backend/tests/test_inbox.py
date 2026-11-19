"""End-to-end check of Chats (team inbox), 360dialog numbers, read-only bot mode and the order sheet PDF.

Runs the real app against a throwaway Postgres schema ("charm_test_inbox") in the database from
backend/.env, with 360dialog/WhatsApp calls faked and no AI key (order IDs are found by pattern).

    cd backend
    .venv/Scripts/python.exe tests/test_inbox.py
"""
import asyncio
import os
import secrets
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
load_dotenv(BACKEND / ".env")

SCHEMA = "charm_test_inbox"
os.environ.update(
    {
        "DB_SCHEMA": SCHEMA,
        "AUTH_SECRET": secrets.token_urlsafe(48),
        "ADMIN_PASSWORD": "legacy-pass-123",
        "RESET_PASSWORD": "",
        "WA_NUMBERS": "",
        "ANTHROPIC_API_KEY": "",
        "AI_PROVIDER": "anthropic",
        "READ_DEBOUNCE_SECONDS": "0.3",
        "PUBLIC_BASE_URL": "https://api.example.test",
    }
)


async def drop_schema():
    conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
    await conn.execute(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE')
    await conn.close()


asyncio.run(drop_schema())

import pymupdf  # noqa: E402
import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

webhook_calls, sent = [], []


async def fake_set_webhook(api_key, url):
    webhook_calls.append((api_key, url))


class FakeResp:
    def __init__(self, status=200, data=None):
        self.status_code, self._data, self.text = status, data or {}, str(data)

    def json(self):
        return self._data


async def fake_wa_post(cfg, path, payload):
    sent.append({"provider": cfg["provider"], "path": path, "payload": payload})
    return FakeResp(200, {"messages": [{"id": f"wamid.OUT{len(sent)}"}]})


server.d360_set_webhook = fake_set_webhook
server.wa_post = fake_wa_post

passed = 0


def check(cond, label, extra=""):
    global passed
    if not cond:
        raise AssertionError(f"FAILED: {label} {extra}")
    passed += 1
    print(f"  ok  {label}")


def H(t):
    return {"Authorization": f"Bearer {t}"}


def meta_payload(messages=None, statuses=None, contacts=None, echoes=None):
    value = {"messaging_product": "whatsapp", "metadata": {"phone_number_id": "999"}}
    if messages:
        value["messages"] = messages
    if statuses:
        value["statuses"] = statuses
    if contacts:
        value["contacts"] = contacts
    if echoes:
        value["message_echoes"] = echoes
    return {"object": "whatsapp_business_account", "entry": [{"id": "1", "changes": [{"field": "messages", "value": value}]}]}


def text_msg(mid, frm, body, ts=None):
    return {"id": mid, "from": frm, "type": "text", "timestamp": str(int(ts or time.time())), "text": {"body": body}}


def wait_for(fn, label, timeout=8.0):
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return True
        time.sleep(0.25)
    raise AssertionError(f"FAILED (timeout): {label}")


try:
    with TestClient(server.app) as c:
        tok = c.post("/api/auth/login", json={"password": "legacy-pass-123"}).json()["token"]
        tok = c.post("/api/account/setup", headers=H(tok), json={"name": "Owner", "email": "o@x.test", "password": "mango-river-42"}).json()["token"]

        print("360dialog number")
        r = c.post("/api/wa/numbers", headers=H(tok), json={"label": "Shop", "provider": "360dialog", "phone_id": "+91 83390 39324", "token": "d360-test-key-0123456789ABCD"})
        check(r.status_code == 201, "add 360dialog number", r.text)
        n = r.json()
        check(n["provider"] == "360dialog" and n["bot_mode"] == "read" and n["phone_id"] == "918339039324", "defaults: read-only bot, digits stored")
        check(n["display"] == "+918339039324" and n["webhook_url"].startswith("https://api.example.test/api/wa/webhook/n/"), "display and webhook URL")
        check(webhook_calls and webhook_calls[-1] == ("d360-test-key-0123456789ABCD", n["webhook_url"]), "webhook set at 360dialog automatically")
        check("d360-test-key" not in str(c.get("/api/wa/numbers", headers=H(tok)).json()), "API key never returned")
        hook = n["webhook_url"].replace("https://api.example.test", "")
        bad = hook.rsplit("/", 1)[0] + "/wrong-key"
        check(c.post(bad, json=meta_payload([text_msg("x1", "919000000001", "hi")])).status_code == 404, "wrong webhook key refused")

        print("Incoming messages and read-only bot")
        r = c.post(hook, json=meta_payload(
            [text_msg("wamid.IN1", "919876543210", "Hi, my order is 123456789012_1 please print Aarav with heart charm")],
            contacts=[{"wa_id": "919876543210", "profile": {"name": "Riya Sharma"}}]))
        check(r.status_code == 200, "webhook accepted")
        convs = c.get("/api/inbox/conversations", headers=H(tok)).json()
        check(len(convs) == 1 and convs[0]["name"] == "Riya Sharma" and convs[0]["unread"] == 1 and convs[0]["window_open"], "chat listed with name, unread and open window")
        check(not sent, "read-only bot sends nothing to the customer")
        wait_for(lambda: c.get("/api/orders?q=919876543210", headers=H(tok)).json(), "order auto-saved after quiet period")
        orders = c.get("/api/orders?q=123456789012", headers=H(tok)).json()
        check(len(orders) == 1 and orders[0]["customer_phone"] == "919876543210" and orders[0]["source"] == "whatsapp" and orders[0]["channel"] == "Shop", "order saved with phone, source and number")
        c.post(hook, json=meta_payload([text_msg("wamid.IN1", "919876543210", "duplicate")]))
        th = c.get("/api/inbox/conversations/Shop/919876543210", headers=H(tok)).json()
        check(len(th["messages"]) == 1 and th["orders"][0]["order_id"] == "123456789012_1", "duplicate delivery ignored; thread shows the order")
        check(c.get("/api/inbox/unread", headers=H(tok)).json()["unread"] == 0, "opening the chat marks it read")

        # flat payload format + a second message that mentions the same order again (no duplicate order)
        c.post(hook, json={"messages": [text_msg("wamid.IN2", "919876543210", "Order 123456789012-1 thanks")], "contacts": []})
        time.sleep(1.2)
        check(len(c.get("/api/orders?q=919876543210", headers=H(tok)).json()) == 1, "flat payload accepted; same order not duplicated")
        check(len(c.get("/api/inbox/conversations/Shop/919876543210", headers=H(tok)).json()["messages"]) == 2, "flat payload message stored")

        print("Replies, ticks, phone-app echoes")
        r = c.post("/api/inbox/send", headers=H(tok), json={"number_label": "Shop", "to": "919876543210", "text": "Thanks Riya! Noted."})
        check(r.status_code == 200 and sent[-1]["provider"] == "360dialog" and sent[-1]["payload"]["text"]["body"] == "Thanks Riya! Noted.", "staff reply sent through 360dialog", r.text)
        out = [m for m in r.json()["messages"] if m["direction"] == "out"][-1]
        check(out["source"] == "staff" and out["status"] == "sent" and out["wa_message_id"] == "wamid.OUT1", "reply stored as staff/sent")
        for st in ("delivered", "read", "delivered"):
            c.post(hook, json=meta_payload(statuses=[{"id": "wamid.OUT1", "status": st, "recipient_id": "919876543210"}]))
        msgs = c.get("/api/inbox/conversations/Shop/919876543210", headers=H(tok)).json()["messages"]
        check([m for m in msgs if m["wa_message_id"] == "wamid.OUT1"][0]["status"] == "read", "ticks move forward and never back")
        c.post(hook, json=meta_payload(echoes=[{"id": "wamid.ECHO1", "from": "918339039324", "to": "919876543210", "type": "text", "timestamp": str(int(time.time())), "text": {"body": "Sent from my phone"}}]))
        msgs = c.get("/api/inbox/conversations/Shop/919876543210", headers=H(tok)).json()["messages"]
        check(any(m["source"] == "phone_app" and m["body"] == "Sent from my phone" for m in msgs), "reply sent from the phone app appears in the chat")

        print("24-hour window and new numbers")
        old = int(time.time()) - 30 * 3600
        c.post(hook, json=meta_payload([text_msg("wamid.OLD", "919111111111", "hello", ts=old)]))
        r = c.post("/api/inbox/send", headers=H(tok), json={"number_label": "Shop", "to": "919111111111", "text": "Hi"})
        check(r.status_code == 409 and "24 hours" in r.json()["detail"], "reply refused after 24 hours")
        r = c.post("/api/inbox/send", headers=H(tok), json={"number_label": "Shop", "to": "91 98989 89898", "text": "Hi"})
        check(r.status_code == 409, "can't start a brand-new chat with a typed message")

        print("Search")
        def found(q):
            return [x["customer_phone"] for x in c.get("/api/inbox/conversations", headers=H(tok), params={"q": q}).json()]
        check(found("123456789012") == ["919876543210"], "search by order ID")
        check(found("98765 43210") == ["919876543210"], "search by phone with spaces")
        check(found("riya") == ["919876543210"], "search by customer name")
        check(found("Aarav") == ["919876543210"], "search by message text / order name")
        check(found("nothing-like-this") == [], "no false matches")

        print("Manual re-read, edit, rename")
        rr = c.post("/api/inbox/conversations/Shop/919876543210/read-orders", headers=H(tok)).json()
        check(len(rr["orders"]) == 1 and rr["ai_ready"] is False, "read order details again (pattern mode without AI)")
        oid = rr["orders"][0]["id"]
        c.patch(f"/api/orders/{oid}", headers=H(tok), json={"product_name": "Aarav", "charm": "Heart"})
        c.post("/api/inbox/conversations/Shop/919876543210/read-orders", headers=H(tok))
        o = c.get("/api/orders?q=123456789012", headers=H(tok)).json()[0]
        check(o["product_name"] == "Aarav" and o["charm"] == "Heart", "staff edits are never overwritten")
        r = c.patch(f"/api/wa/numbers/{n['id']}", headers=H(tok), json={"label": "Main Shop", "bot_mode": "off"})
        check(r.json()["label"] == "Main Shop" and r.json()["bot_mode"] == "off", "rename + bot mode change")
        check(found("riya") == ["919876543210"] and c.get("/api/inbox/conversations/Main Shop/919876543210", headers=H(tok)).status_code == 200, "chat history follows the rename")

        print("Order sheet PDF")
        now = datetime.now(timezone.utc)
        params = {"start": (now - timedelta(hours=1)).isoformat(), "end": (now + timedelta(hours=1)).isoformat(), "tz": 330, "title": "Today"}
        r = c.get("/api/orders/sheet.pdf", headers=H(tok), params=params)
        check(r.status_code == 200 and r.headers["content-type"] == "application/pdf", "sheet PDF returned")
        text = pymupdf.open(stream=r.content, filetype="pdf")[0].get_text()
        check("123456789012_1" in text and "Aarav" in text and "+919876543210" in text and "order sheet" in text, "sheet lists the order", text[:300])
        bad = c.get("/api/orders/sheet.pdf", headers=H(tok), params={"start": "2026-01-01", "end": "2026-12-31"})
        check(bad.status_code == 400, "period over 3 months refused")
        check(c.get("/api/orders/sheet.pdf", params=params).status_code == 401, "sheet needs login")

    print(f"\nALL {passed} CHECKS PASSED")
finally:
    asyncio.run(drop_schema())
    print(f"(dropped test schema {SCHEMA})")
