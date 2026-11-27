"""Order IDs match on their first 8 digits: search (Orders, Chats, Customer Data) and Label Studio.

Runs the real app against a throwaway Postgres schema in the database from backend/.env. Made-up data only.

    cd backend
    .venv/Scripts/python.exe tests/test_id_prefix.py
"""
import asyncio
import os
import secrets
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
load_dotenv(BACKEND / ".env")

SCHEMA = "charm_test_prefix_" + secrets.token_hex(4)
os.environ.update({"DB_SCHEMA": SCHEMA, "AUTH_SECRET": secrets.token_urlsafe(48), "ADMIN_PASSWORD": "legacy-pass-123",
                   "BOT_REPLY_WAIT_SECONDS": "0", "RESET_PASSWORD": "", "WA_NUMBERS": "", "ANTHROPIC_API_KEY": "",
                   "AI_PROVIDER": "anthropic"})


async def sql(query, *args):
    conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
    try:
        if query.startswith("DROP"):
            return await conn.execute(query)
        await conn.execute(f'SET search_path TO "{SCHEMA}"')
        return await conn.execute(query, *args)
    finally:
        await conn.close()


import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

passed = 0


def check(cond, label, extra=""):
    global passed
    if not cond:
        raise AssertionError(f"FAILED: {label} {extra}")
    passed += 1
    print(f"  ok  {label}")


def H(t):
    return {"Authorization": f"Bearer {t}"}


try:
    print("Saved IDs are cleaned")
    b = server.build_order
    check(b({"order_id": "Order#347600000000000304"})["order_id"] == "347600000000000304", "'Order#' removed")
    check(b({"order_id": "order id: 3476 0000 0000 0003 04"})["order_id"] == "347600000000000304", "'order id:' and spaces removed")
    check(b({"order_id": "OD123400000000000100"})["order_id"] == "OD123400000000000100", "Flipkart OD kept")

    print("Label Studio matching")
    M, S, P = server.match_orders, server.label_status, server.partial_digits
    orders = [{"order_id": "357111112222333344"}, {"order_id": "Order#357999990000111122"},
              {"order_id": "358222220000000000"}, {"order_id": "358222229999999999"}]
    m = M(["357111112222333344_1"], orders)
    check(len(m) == 1 and S(["357111112222333344_1"], m) == "matched" and P(["357111112222333344_1"], m) == 0, "_1 ending: full match, no note")
    m = M(["357999990000111122_1"], orders)
    check(len(m) == 1 and P(["357999990000111122_1"], m) == 0, "'Order#' saved ID: full match, no note", m)
    m = M(["357111119999999999_1"], orders)
    check(len(m) == 1 and m[0]["order_id"] == "357111112222333344" and S(["357111119999999999_1"], m) == "matched"
          and P(["357111119999999999_1"], m) == 8, "first 8 digits match: details added, note says 8", m)
    m = M(["357111112299999999_1"], orders)
    check(P(["357111112299999999_1"], m) == 10, "longest shared start reported (10)")
    m = M(["358222221111111111_1"], orders)
    check(len(m) == 2 and S(["358222221111111111_1"], m) == "needs_review", "two orders tied on the first 8+ digits: needs review", m)
    check(M(["357111100000000000_1"], orders) == [], "only 7 digits shared: not found")

    with TestClient(server.app) as c:
        tok = c.post("/api/auth/login", json={"password": "legacy-pass-123"}).json()["token"]
        tok = c.post("/api/account/setup", headers=H(tok), json={"name": "Owner", "email": "o@x.test", "password": "mango-river-42"}).json()["token"]
        mk = lambda **kw: c.post("/api/orders", headers=H(tok), json=kw).json()  # noqa: E731
        mk(order_id="357444445555666677", product_name="AARAV", customer_phone="919000000401", channel="Shop")
        mk(order_id="OD440000111122223333", product_name="MEERA", customer_phone="919000000402", channel="Shop")
        ids = lambda r: sorted(o["order_id"] for o in r.json())  # noqa: E731

        print("Orders search")
        check(ids(c.get("/api/orders", headers=H(tok), params={"q": "357444449999999999"})) == ["357444445555666677"],
              "search: the first 8 digits find it (rest differs)")
        check(ids(c.get("/api/orders", headers=H(tok), params={"order_id": "357444449999999999_1"})) == ["357444445555666677"],
              "order ID filter: first 8 digits")
        check(ids(c.get("/api/orders", headers=H(tok), params={"q": "357444"})) == ["357444445555666677"], "short search still works")
        check(ids(c.get("/api/orders", headers=H(tok), params={"q": "357440000000000000"})) == [], "7 shared digits: no match")
        check(ids(c.get("/api/orders", headers=H(tok), params={"q": "OD440000119999999999"})) == ["OD440000111122223333"], "Flipkart: first 8 digits after OD")

        print("Chats search")
        c.portal.call(server.record_message, "Shop", "919000000403", "in", "text", "my order 3576 1234 5555 6666", None, "received", "customer")
        c.portal.call(server.record_message, "Shop", "919000000401", "in", "text", "hello", None, "received", "customer")
        chats = lambda q: [x["customer_phone"] for x in c.get("/api/inbox/conversations", headers=H(tok), params={"q": q}).json()]  # noqa: E731
        check("919000000403" in chats("357612349999999999"), "an ID typed with spaces in a message is found by its first 8 digits")
        check("919000000401" in chats("357444449999999999"), "a chat is found by its saved order's first 8 digits")
        check("919000000403" not in chats("357612000000000000"), "7 shared digits: not found")

        print("Customer Data search")
        cd = c.get("/api/customer-data", headers=H(tok), params={"order_id": "357444449999999999"}).json()
        rows = cd["rows"] if isinstance(cd, dict) and "rows" in cd else cd.get("records", cd) if isinstance(cd, dict) else cd
        check("357444445555666677" in str(cd), "Customer Data: first 8 digits find the order", str(cd)[:300])

    print(f"\nALL {passed} CHECKS PASSED")
finally:
    asyncio.run(sql(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE'))
    print(f"(dropped test schema {SCHEMA})")
