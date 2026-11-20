"""Check that the read-only bot's background reads survive a server restart.

Runs the real app against a throwaway Postgres schema ("charm_test_reads") in the database from backend/.env,
starting and stopping it like a deploy would. WhatsApp is faked; no AI key (order IDs are found by pattern).

    cd backend
    .venv/Scripts/python.exe tests/test_reads.py
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

SCHEMA = "charm_test_reads"
os.environ.update(
    {
        "DB_SCHEMA": SCHEMA,
        "AUTH_SECRET": secrets.token_urlsafe(48),
        "ADMIN_PASSWORD": "legacy-pass-123",
        "RESET_PASSWORD": "",
        "WA_NUMBERS": "",
        "ANTHROPIC_API_KEY": "",
        "AI_PROVIDER": "anthropic",
        "READ_DEBOUNCE_SECONDS": "0.5",
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


server.d360_set_webhook = fake_set_webhook

reads = []  # (number, phone) for every read that ran
fail_next = []
real_read = server.read_order_details


async def counting_read(label, customer):
    reads.append((label, customer))
    if fail_next:
        fail_next.pop()
        raise RuntimeError("simulated failure (e.g. database hiccup)")
    return await real_read(label, customer)


server.read_order_details = counting_read
server.READ_RETRY_S = 1

passed = 0


def check(cond, label, extra=""):
    global passed
    if not cond:
        raise AssertionError(f"FAILED: {label} {extra}")
    passed += 1
    print(f"  ok  {label}")


def H(t):
    return {"Authorization": f"Bearer {t}"}


def msg(hook, c, mid, frm, body):
    value = {"contacts": [{"wa_id": frm, "profile": {"name": "Cust"}}],
             "messages": [{"id": mid, "from": frm, "type": "text", "timestamp": str(int(time.time())), "text": {"body": body}}]}
    assert c.post(hook, json={"object": "whatsapp_business_account", "entry": [{"changes": [{"field": "messages", "value": value}]}]}).status_code == 200


def wait_for(fn, label, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return True
        time.sleep(0.2)
    raise AssertionError(f"FAILED (timeout): {label}")


async def due(phone):
    conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
    await conn.execute(f'SET search_path TO "{SCHEMA}"')
    row = await conn.fetchrow("SELECT read_due_at, read_attempts FROM wa_contacts WHERE customer_phone = $1", phone)
    await conn.close()
    return row


try:
    with TestClient(server.app) as c:
        tok = c.post("/api/auth/login", json={"password": "legacy-pass-123"}).json()["token"]
        tok = c.post("/api/account/setup", headers=H(tok), json={"name": "Owner", "email": "o@x.test", "password": "mango-river-42"}).json()["token"]
        n = c.post("/api/wa/numbers", headers=H(tok), json={"label": "Shop", "provider": "360dialog", "phone_id": "918339039324", "token": "d360-test-key-0123456789ABCD"}).json()
        hook = n["webhook_url"].replace("https://api.example.test", "")

        print("Normal read")
        msg(hook, c, "w1", "919000000001", "Order 111111111111_1 please")
        wait_for(lambda: c.get("/api/orders?q=111111111111", headers=H(tok)).json(), "order saved by the worker")
        check(asyncio.run(due("919000000001"))["read_due_at"] is None, "schedule cleared after reading")

        print("A burst of messages is read once")
        reads.clear()
        server.READ_DEBOUNCE_S = 5  # each fake message takes a moment against the real database
        for i in range(3):
            msg(hook, c, f"b{i}", "919000000002", f"part {i}" if i < 2 else "Order 222222222222_1")
        wait_for(lambda: c.get("/api/orders?q=222222222222", headers=H(tok)).json(), "order from the burst saved", timeout=25)
        server.READ_DEBOUNCE_S = 0.5
        time.sleep(1.5)
        check(reads.count(("Shop", "919000000002")) == 1, "one read for three quick messages", str(reads))

        print("Waiting read when the server stops")
        server.READ_DEBOUNCE_S = 30  # long quiet period: the server stops before the read is due
        msg(hook, c, "r1", "919000000003", "Order 333333333333_1 thanks")
        check(asyncio.run(due("919000000003"))["read_due_at"] is not None, "read waiting when the server stops")
    # --- server stopped (like a deploy) ---
    check(not reads.count(("Shop", "919000000003")), "nothing read before the stop")
    async def make_due_now():
        conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
        await conn.execute(f'SET search_path TO "{SCHEMA}"')
        await conn.execute("UPDATE wa_contacts SET read_due_at = now() - interval '5 seconds' WHERE customer_phone = '919000000003'")
        await conn.close()
    asyncio.run(make_due_now())  # time passes while the server is down
    server.READ_DEBOUNCE_S = 0.5

    with TestClient(server.app) as c:
        tok = c.post("/api/auth/login", json={"email": "o@x.test", "password": "mango-river-42"}).json()["token"]
        print("After the restart")
        wait_for(lambda: c.get("/api/orders?q=333333333333", headers=H(tok)).json(), "waiting read done after the restart")
        check(reads.count(("Shop", "919000000003")) == 1, "read exactly once")

        print("A failed read is retried")
        fail_next.append(1)
        msg(hook, c, "f1", "919000000004", "Order 444444444444_1")
        wait_for(lambda: reads.count(("Shop", "919000000004")) >= 1, "first attempt ran")
        wait_for(lambda: (asyncio.run(due("919000000004")) or {}).get("read_attempts") == 1, "failure recorded and retry scheduled")
        wait_for(lambda: c.get("/api/orders?q=444444444444", headers=H(tok)).json(), "retry saved the order")
        check(reads.count(("Shop", "919000000004")) == 2, "two attempts in total")

    print(f"\nALL {passed} CHECKS PASSED")
finally:
    asyncio.run(drop_schema())
    print(f"(dropped test schema {SCHEMA})")
