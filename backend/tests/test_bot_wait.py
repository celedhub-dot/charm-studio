"""Check that the ask-questions bot waits for the customer to pause, reads split messages together, follows the
shop's own numbered greeting, saves colour/quantity, and still replies after a restart.

Runs the real app against a throwaway Postgres schema ("charm_test_botwait") in the database from backend/.env.
WhatsApp is faked; no AI key (details are read by pattern).

    cd backend
    .venv/Scripts/python.exe tests/test_bot_wait.py
"""
import asyncio
import os
import secrets
import sys
import time
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
load_dotenv(BACKEND / ".env")

SCHEMA = "charm_test_botwait"
os.environ.update(
    {
        "DB_SCHEMA": SCHEMA,
        "AUTH_SECRET": secrets.token_urlsafe(48),
        "ADMIN_PASSWORD": "legacy-pass-123",
        "RESET_PASSWORD": "",
        "WA_NUMBERS": "",
        "ANTHROPIC_API_KEY": "",
        "AI_PROVIDER": "anthropic",
        "BOT_REPLY_WAIT_SECONDS": "4",
        "PUBLIC_BASE_URL": "https://api.example.test",
    }
)


async def drop_schema():
    conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
    await conn.execute(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE')
    await conn.close()


asyncio.run(drop_schema())

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


async def fake_set_webhook(api_key, url):
    return None


sent = []  # (to, text) for every bot reply


async def fake_send(cfg, to, text, source="bot"):
    sent.append((to, text))


server.d360_set_webhook = fake_set_webhook
server.send_wa = fake_send
passed = 0


def check(cond, label, extra=""):
    global passed
    if not cond:
        raise AssertionError(f"FAILED: {label} {extra}")
    passed += 1
    print(f"  ok  {label}")


def H(t):
    return {"Authorization": f"Bearer {t}"}


def post(c, hook, value):
    r = c.post(hook, json={"object": "whatsapp_business_account", "entry": [{"changes": [{"field": "messages", "value": value}]}]})
    assert r.status_code == 200


def msg(c, hook, mid, frm, body):
    post(c, hook, {"contacts": [{"wa_id": frm, "profile": {"name": "Cust"}}],
                   "messages": [{"id": mid, "from": frm, "type": "text", "timestamp": str(int(time.time())), "text": {"body": body}}]})


def shop_says(c, hook, mid, to, body):  # a message the shop sent from the WhatsApp Business app
    post(c, hook, {"message_echoes": [{"id": mid, "to": to, "type": "text", "timestamp": str(int(time.time())), "text": {"body": body}}]})


def replies_to(phone):
    return [t for to, t in sent if to == phone]


def wait_for(fn, label, timeout=20.0):
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return True
        time.sleep(0.3)
    raise AssertionError(f"FAILED (timeout): {label}")


GREETING = """PLACE ORDER ON FLIPKART

1 - Text me ORDER ID send me
2 - Name on wallet /EMBOSSED NAME on product
3 - Select Charm number
4 - Quantity

Send this informations then your order AUTOMATICALLY confirm"""

try:
    with TestClient(server.app) as c:
        tok = c.post("/api/auth/login", json={"password": "legacy-pass-123"}).json()["token"]
        tok = c.post("/api/account/setup", headers=H(tok), json={"name": "Owner", "email": "o@x.test", "password": "mango-river-42"}).json()["token"]
        n = c.post("/api/wa/numbers", headers=H(tok), json={"label": "Shop", "provider": "360dialog", "phone_id": "918339039324", "token": "d360-test-key-0123456789ABCD"}).json()
        c.patch(f"/api/wa/numbers/{n['id']}", headers=H(tok), json={"bot_mode": "ask"})
        hook = n["webhook_url"].replace("https://api.example.test", "")

        print("Details split over several quick messages")
        a = "919000000011"
        msg(c, hook, "a1", a, "Hi, my order is 123456789012_1")
        msg(c, hook, "a2", a, "name AARAV")
        msg(c, hook, "a3", a, "charm no 5, qty 2, black colour")
        check(not replies_to(a), "no reply while the customer is still typing")
        wait_for(lambda: replies_to(a), "bot replies after the pause")
        time.sleep(1.5)
        check(len(replies_to(a)) == 1 and "note" in replies_to(a)[0].lower(), "one reply, asking only what's missing", str(replies_to(a)))
        msg(c, hook, "a4", a, "none")
        wait_for(lambda: c.get("/api/orders?q=123456789012", headers=H(tok)).json(), "order saved")
        o = c.get("/api/orders?q=123456789012", headers=H(tok)).json()[0]
        check((o["product_name"], o["charm"], o["quantity"], o["colour"]) == ("AARAV", "5", "2", "black"), "name, charm number, quantity and colour saved", o)
        wait_for(lambda: len(replies_to(a)) == 2, "thank-you sent")
        check("Quantity: 2" in replies_to(a)[1] and "Colour: black" in replies_to(a)[1], "thank-you lists colour and quantity", replies_to(a)[1])

        print("A reply laid out like the shop's numbered greeting")
        b = "919000000012"
        shop_says(c, hook, "g1", b, GREETING)
        msg(c, hook, "b1", b, "1- 987654321098_1\n2- KABIR\n3- 12\n4- 1")
        wait_for(lambda: replies_to(b), "bot replies")
        msg(c, hook, "b2", b, "no")
        wait_for(lambda: c.get("/api/orders?q=987654321098", headers=H(tok)).json(), "order saved")
        o = c.get("/api/orders?q=987654321098", headers=H(tok)).json()[0]
        check((o["order_id"], o["product_name"], o["charm"], o["quantity"]) == ("987654321098_1", "KABIR", "12", "1"), "numbered reply mapped to the shop's fields", o)

        print("Plain values one per line, in the shop's order")
        d = "919000000013"
        shop_says(c, hook, "g2", d, GREETING)
        msg(c, hook, "d1", d, "555566667777_1\nMeera\n7\n3")
        wait_for(lambda: replies_to(d), "bot replies")
        msg(c, hook, "d2", d, "gift wrap please")
        wait_for(lambda: c.get("/api/orders?q=555566667777", headers=H(tok)).json(), "order saved")
        o = c.get("/api/orders?q=555566667777", headers=H(tok)).json()[0]
        check((o["product_name"], o["charm"], o["quantity"], o["notes"]) == ("Meera", "7", "3", "gift wrap please"), "unlabelled lines follow the shop's list", o)

        print("A reply waiting when the server stops")
        server.BOT_WAIT_S = 60
        e = "919000000014"
        msg(c, hook, "e1", e, "Order 444455556666_1 name Riya heart charm")
    check(not replies_to(e), "nothing sent before the stop")

    async def make_due_now():
        conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
        await conn.execute(f'SET search_path TO "{SCHEMA}"')
        await conn.execute("UPDATE wa_contacts SET bot_due_at = now() - interval '1 second' WHERE customer_phone = '919000000014'")
        await conn.close()
    asyncio.run(make_due_now())
    server.BOT_WAIT_S = 4
    with TestClient(server.app) as c:
        wait_for(lambda: replies_to(e), "reply sent after the restart")
        time.sleep(1.5)
        check(len(replies_to(e)) == 1 and "note" in replies_to(e)[0].lower(), "sent exactly once, asking for notes", str(replies_to(e)))

    print(f"\nALL {passed} CHECKS PASSED")
finally:
    asyncio.run(drop_schema())
    print(f"(dropped test schema {SCHEMA})")
