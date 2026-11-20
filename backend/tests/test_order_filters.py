"""Check order filters (date, phone, order ID), marketplace order dates, the grouped order sheet and filtered CSV.

Runs the real app against a throwaway Postgres schema ("charm_test_filters") in the database from backend/.env.
No AI key; WhatsApp sends are faked.

    cd backend
    .venv/Scripts/python.exe tests/test_order_filters.py
"""
import asyncio
import csv
import io
import os
import secrets
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
load_dotenv(BACKEND / ".env")

SCHEMA = "charm_test_filters"
os.environ.update({"DB_SCHEMA": SCHEMA, "AUTH_SECRET": secrets.token_urlsafe(48), "ADMIN_PASSWORD": "legacy-pass-123",
                   "RESET_PASSWORD": "", "WA_NUMBERS": "", "ANTHROPIC_API_KEY": "", "AI_PROVIDER": "anthropic"})


async def sql(query, *args):
    conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
    try:
        if query.startswith("DROP"):
            return await conn.execute(query)
        await conn.execute(f'SET search_path TO "{SCHEMA}"')
        return await conn.execute(query, *args)
    finally:
        await conn.close()


asyncio.run(sql(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE'))

import pymupdf  # noqa: E402
import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

sent = []


class FakeResp:
    status_code, text = 200, "{}"

    def json(self):
        return {"messages": [{"id": f"wamid.F{len(sent)}"}]}


async def fake_wa_post(cfg, path, payload):
    sent.append(payload)
    return FakeResp()


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


IST = timedelta(hours=5, minutes=30)


def day_range(y, m, d):
    """ISO start/end of a day in India time, like the browser sends."""
    start = datetime(y, m, d, tzinfo=timezone(IST))
    return start.isoformat(), (start + timedelta(days=1)).isoformat()


try:
    with TestClient(server.app) as c:
        tok = c.post("/api/auth/login", json={"password": "legacy-pass-123"}).json()["token"]
        tok = c.post("/api/account/setup", headers=H(tok), json={"name": "Owner", "email": "o@x.test", "password": "mango-river-42"}).json()["token"]

        print("Order date values")
        P = server.parse_order_date
        check([str(P(x)) for x in ("2026-11-18", "18/11/2026", "18.11.26", "18-Nov-2026", "Nov 18, 2026")] == ["2026-11-18"] * 5, "common date formats read")
        check(P("31/02/2026") is None and P("2031-01-01") is None and P("soon") is None, "impossible, future and non-dates refused")
        check(str(server.detect_label_date("Invoice Date: 19/11/2026  Order Date: 17.11.2026")) == "2026-11-17", "label: 'Order Date' preferred over 'Invoice Date'")

        print("Orders with dates and phones")
        mk = lambda **kw: c.post("/api/orders", headers=H(tok), json=kw).json()  # noqa: E731
        a = mk(order_id="123456789012_1", product_name="AARAV", charm="Heart", customer_phone="919876543210", order_date="2026-11-17")
        b = mk(order_id="OD432198765432109876", product_name="Meera", charm="Star", customer_phone="+91 70000 11111")
        cc = mk(order_id="987654321098_1", product_name="ISHAAN", charm="Moon", customer_phone="919876543210", order_date="18/11/2026")
        check(a["order_date"] == "2026-11-17" and cc["order_date"] == "2026-11-18" and b["order_date"] is None, "order date stored from different formats")
        # b has no marketplace date and was saved on 18 Nov (India time)
        asyncio.run(sql("UPDATE orders SET created_at = $1 WHERE id = $2", datetime(2026, 11, 18, 4, 0, tzinfo=timezone.utc), b["id"]))
        asyncio.run(sql("UPDATE orders SET created_at = $1 WHERE id IN ($2, $3)", datetime(2026, 11, 19, 6, 0, tzinfo=timezone.utc), a["id"], cc["id"]))

        ids = lambda r: sorted(o["order_id"] for o in r.json())  # noqa: E731
        print("Filters")
        check(ids(c.get("/api/orders", headers=H(tok), params={"phone": "98765 43210"})) == ["123456789012_1", "987654321098_1"], "phone: partial, spaces ignored")
        check(ids(c.get("/api/orders", headers=H(tok), params={"phone": "+91-70000"})) == ["OD432198765432109876"], "phone: +91 and dashes ignored")
        check(ids(c.get("/api/orders", headers=H(tok), params={"order_id": "1234-5678-9012"})) == ["123456789012_1"], "order ID: partial, dashes ignored")
        check(ids(c.get("/api/orders", headers=H(tok), params={"order_id": "od4321"})) == ["OD432198765432109876"], "order ID: case ignored")
        s17, e17 = day_range(2026, 11, 17)
        s18, e18 = day_range(2026, 11, 18)
        s19, e19 = day_range(2026, 11, 19)
        check(ids(c.get("/api/orders", headers=H(tok), params={"start": s17, "end": e17, "tz": 330})) == ["123456789012_1"], "date: uses the marketplace date (saved 19th, ordered 17th)")
        check(ids(c.get("/api/orders", headers=H(tok), params={"start": s18, "end": e18, "tz": 330})) == ["987654321098_1", "OD432198765432109876"],
              "date: order without a marketplace date falls back to its saved date")
        check(ids(c.get("/api/orders", headers=H(tok), params={"start": s19, "end": e19, "tz": 330})) == [], "date: saved date ignored when a marketplace date exists")
        check(ids(c.get("/api/orders", headers=H(tok), params={"start": s17, "end": e19, "tz": 330, "phone": "9876543210"})) == ["123456789012_1", "987654321098_1"], "filters combine (date range + phone)")
        check(c.get("/api/orders", headers=H(tok), params={"phone": "abc"}).status_code == 400, "phone filter with no digits refused")

        print("Order sheet")
        r = c.get("/api/orders/sheet.pdf", headers=H(tok), params={"start": s17, "end": e19, "tz": 330, "title": "17 to 19 Nov"})
        check(r.status_code == 200, "sheet for a date range", r.text[:200])
        text = pymupdf.open(stream=r.content, filetype="pdf")[0].get_text()
        check("Tuesday, 17 Nov 2026" in text and "Wednesday, 18 Nov 2026" in text, "orders grouped under date headings", text[:400])
        check(text.index("17 Nov 2026") < text.index("123456789012_1") < text.index("18 Nov 2026"), "each order under its own date")
        check("OD432198765432109876 *" in text and "saved" in text, "order without a marketplace date marked with * and explained")
        r = c.get("/api/orders/sheet.pdf", headers=H(tok), params={"phone": "9876543210", "tz": 330})
        text = pymupdf.open(stream=r.content, filetype="pdf")[0].get_text()
        check(r.status_code == 200 and "123456789012_1" in text and "987654321098_1" in text and "OD4321" not in text and "phone 9876543210" in text,
              "sheet for one phone number, no dates needed")
        r = c.get("/api/orders/sheet.pdf", headers=H(tok), params={"order_id": "OD432198765432109876", "tz": 330})
        check(r.status_code == 200 and "Meera" in pymupdf.open(stream=r.content, filetype="pdf")[0].get_text(), "sheet for one order ID")
        check(c.get("/api/orders/sheet.pdf", headers=H(tok)).status_code == 400, "sheet needs a date, phone or order ID")
        check(c.get("/api/orders/sheet.pdf", headers=H(tok), params={"start": s17}).status_code == 400, "start without end refused")

        print("CSV export")
        rows = list(csv.DictReader(io.StringIO(c.get("/api/orders/export.csv", headers=H(tok), params={"phone": "9876543210"}).content.decode("utf-8-sig"))))
        check(sorted(r["order_id"] for r in rows) == ["123456789012_1", "987654321098_1"] and rows[0]["order_date"], "CSV follows the filters and has the order date")
        rows = list(csv.DictReader(io.StringIO(c.get("/api/orders/export.csv", headers=H(tok)).content.decode("utf-8-sig"))))
        check(len(rows) == 3, "CSV without filters exports everything")

        print("Editing the order date")
        r = c.patch(f"/api/orders/{b['id']}", headers=H(tok), json={"order_date": "16 Nov 2026"})
        check(r.json()["order_date"] == "2026-11-16", "order date can be set")
        check(c.patch(f"/api/orders/{b['id']}", headers=H(tok), json={"order_date": "32/13/2026"}).status_code == 400, "bad order date refused")
        check(c.patch(f"/api/orders/{b['id']}", headers=H(tok), json={"order_date": ""}).json()["order_date"] is None, "empty clears it")

        print("Label Studio saves the date printed on labels")
        doc = pymupdf.open()
        for oid, line in (("OD432198765432109876", "Order Date: 15.11.2026"), ("123456789012_1", "Order Date: 01.11.2026")):
            pg = doc.new_page()
            pg.insert_text((50, 80), f"Order No. {oid}", fontsize=12)
            pg.insert_text((50, 110), line, fontsize=12)
        pdf = doc.tobytes()
        an = c.post("/api/pdf/analyze", headers=H(tok), files={"file": ("labels.pdf", pdf, "application/pdf")}).json()
        check([p["label_date"] for p in an["pages"]] == ["2026-11-15", "2026-11-01"], "analyze shows the date found on each label")
        r = c.post("/api/pdf/annotate", headers=H(tok), files={"file": ("labels.pdf", pdf, "application/pdf")}, data={"position": "bottom-right"})
        check(r.status_code == 200 and r.headers["x-order-dates-saved"] == "1", "annotate saves the label date only where none was saved", r.headers.get("x-order-dates-saved"))
        got = {o["order_id"]: o["order_date"] for o in c.get("/api/orders", headers=H(tok)).json()}
        check(got["OD432198765432109876"] == "2026-11-15" and got["123456789012_1"] == "2026-11-17", "label date filled in; existing date not overwritten")

        print("Ask-questions bot keeps the customer's phone")
        n = c.post("/api/wa/numbers", headers=H(tok), json={"label": "Shop", "phone_id": "1234567890", "token": "EAAtest-token-0123456789", "skip_check": True}).json()
        cfg = server.find_number(n["id"])
        for msg in ("hi", "555666777888_1", "ZOYA", "flower", "none"):
            c.portal.call(server.handle_bot_message, cfg, "919111222333", msg)  # run on the app's event loop
        got = [o for o in c.get("/api/orders", headers=H(tok), params={"phone": "9111222333"}).json()]
        check(len(got) == 1 and got[0]["order_id"] == "555666777888_1" and got[0]["customer_phone"] == "919111222333", "bot-saved order has the phone, so the phone filter finds it")

    print(f"\nALL {passed} CHECKS PASSED")
finally:
    asyncio.run(sql(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE'))
    print(f"(dropped test schema {SCHEMA})")
