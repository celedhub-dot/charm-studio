"""Catalogue rules, screenshot reading (free OCR first, AI second), S- codes, combos and logo photos.
Made-up numbers and products only. WhatsApp, the OCR service and the AI are faked; nothing is billed.

    cd backend
    .venv/Scripts/python.exe tests/test_catalogue_bot.py
"""
import asyncio
import io
import json
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

SCHEMA = "charm_test_catalogue"
os.environ.update({"DB_SCHEMA": SCHEMA, "AUTH_SECRET": secrets.token_urlsafe(48), "ADMIN_PASSWORD": "legacy-pass-123",
                   "RESET_PASSWORD": "", "WA_NUMBERS": "", "ANTHROPIC_API_KEY": "sk-ant-test-not-real", "AI_PROVIDER": "anthropic",
                   "BOT_REPLY_WAIT_SECONDS": "1", "READ_DEBOUNCE_SECONDS": "1", "PUBLIC_BASE_URL": "https://api.example.test",
                   "OCR_URL": "https://ocr.example.test", "OCR_KEY": "test-ocr-key"})


async def drop_schema():
    conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
    await conn.execute(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE')
    await conn.close()


asyncio.run(drop_schema())


async def sql_exec(q, *args):
    conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
    await conn.execute(q, *args)
    await conn.close()


import catalogue as cat  # noqa: E402
import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

sent, ai_calls, ocr_calls = [], [], []
OCR_TEXT = {}      # media id -> OCR text
VISION = {}        # media id -> what the AI "sees"
BOT_TURNS = []     # queued AI answers for the bot


async def fake_send(cfg, to, text, source="bot"):
    sent.append((to, text))
    await server.record_message(cfg["logical_id"], to, "out", "text", text, None, "sent", source)


async def fake_guide(cfg, customer, caption):
    sent.append((customer, "[guide picture] " + caption))
    await server.record_message(cfg["logical_id"], customer, "out", "image", caption, None, "sent", "bot")
    return True


async def fake_fetch(cfg, media_id):
    return media_id.encode(), "image/jpeg"


async def fake_ocr(data):
    ocr_calls.append(data.decode())
    return OCR_TEXT.get(data.decode(), "")


async def fake_claude(system, user, max_tokens=16000, effort=None, model=None):
    ai_calls.append(system[:30])
    if system == server.SCREENSHOT_SYSTEM:
        media = user[0]["source"]["data"]
        import base64
        return json.dumps(VISION.get(base64.b64decode(media).decode(), {"order_page": False}))
    if system == server.BOT_TURN_SYSTEM:
        return json.dumps(BOT_TURNS.pop(0) if BOT_TURNS else {"action": "silent"})
    return "[]"


async def fake_lang(*a, **k):
    return ""


async def fake_localize(t, language):
    return t


async def fake_set_webhook(api_key, url):
    return None


server.send_wa = fake_send
server.send_order_guide = fake_guide
server.fetch_media = fake_fetch
server.ocr_text = fake_ocr
server.claude_text = fake_claude
server.chat_language = fake_lang
server.localize_reply = fake_localize
server.d360_set_webhook = fake_set_webhook
passed = 0


def check(cond, label, extra=""):
    global passed
    if not cond:
        raise AssertionError(f"FAILED: {label} {extra}")
    passed += 1
    print(f"  ok  {label}")


def H(t):
    return {"Authorization": f"Bearer {t}"}


def meesho_file() -> bytes:
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["SERIAL NO", "CATALOG NAME", "CATALOG ID", "PRODUCT NAME", "PRODUCT ID", "STYLE ID", "VARIATION ID", "VARIATION",
               "STOCK", "SYSTEM STOCK COUNT", "YOUR STOCK COUNT"])
    ws.append(["Row identifier", "Catalog name", "Catalog id", "Product name", "Product id", "Style", "Var", "Variation", "Stock", "Count", "Edit"])
    for i, title in enumerate(["Special Customised Doctor keychain with name | Doctor symbol keychain",
                               "Customised Wallet, Pen & Metal Keychain Combo Pack for Men Brown",
                               "Customised Wallet for Men with Name & Charm Customization Blue",
                               "Mens Leather Belt Black"], 1):
        ws.append([i, "Test catalog", "100", title, str(1000000 + i), f"S{i}", "1", "Free Size", "ALL", "10", ""])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


try:
    print("Product rules")
    n = cat.needs_for
    check(n("Customised Wallet for Men with Name & Charm")["charm"] and not n("Customised Wallet for Men")["items"], "wallet: name + charm")
    check(not n("Special Customised Doctor keychain with name")["charm"] and n("Special Customised Doctor keychain with name")["logo"],
          "metal keychain: name or logo, no charm number")
    check(n("Personalised leather keychain")["charm"], "leather keychain: charm number")
    check(n("Customised Wallet, Pen & Metal Keychain Combo")["items"] == ["wallet", "metal keychain", "pen"], "combo items")
    check(not n("Mens Leather Belt")["name"] and not n("Card holder for men")["name"], "belts and card holders: nothing")
    check(not n("Customised Name Bracelet")["charm"] and not n("pack of 6 rakhi")["charm"], "bracelet / rakhi: name only")
    check(n("Silver Glitter passport cover")["charm"], "passport cover: charm")
    check(not n("Neck chain with name")["charm"] and n("Neck chain with name")["name"], "chain: name only")
    check(not n("Personalised metal pen")["charm"], "pen: name only")
    check(not n("Remote Control Car")["known"], "unknown product keeps asking name + charm")

    print("Free OCR text -> order")
    o = server.ocr_order("ORDER DETAILS\nOrder #357100000000000336\nSpecial Customised Doctor keychain with na...\nFree Size • Prepaid\nAWB 1490843210642520")
    check(o and o["order_id"] == "357100000000000336", "order number read, AWB ignored", o)
    check(server.ocr_order("Happy birthday 357100000000000336") is None, "no order words: not an order page")
    check(server.ocr_order("Order ID: OD439161640237637100 Flipkart")["order_id"] == "OD439161640237637100", "Flipkart OD")

    with TestClient(server.app) as c:
        tok = c.post("/api/auth/login", json={"password": "legacy-pass-123"}).json()["token"]
        tok = c.post("/api/account/setup", headers=H(tok), json={"name": "Owner", "email": "o@x.test", "password": "mango-river-42"}).json()["token"]
        num = c.post("/api/wa/numbers", headers=H(tok), json={"label": "Shop M", "provider": "360dialog", "phone_id": "918339039324",
                                                               "token": "d360-test-key-0123456789ABCD"}).json()
        c.patch(f"/api/wa/numbers/{num['id']}", headers=H(tok), json={"bot_mode": "ask"})
        hook = num["webhook_url"].replace("https://api.example.test", "")

        print("Catalogue upload")
        r = c.post("/api/catalogue/import", headers=H(tok), data={"shop": "Meestuffs"},
                   files={"file": ("Inventory-Update-File.xlsx", meesho_file(), "application/octet-stream")})
        check(r.status_code == 200 and r.json()["products"] == 4 and r.json()["marketplace"] == "meesho", "Meesho file read", r.text)
        cat_view = c.get("/api/catalogue", headers=H(tok)).json()
        check(cat_view["files"][0]["active"] == 4 and any(t["asks"] == "nothing" for t in cat_view["types"]), "summary + what the bot asks", cat_view)
        check("price" not in json.dumps(cat_view).lower(), "no prices kept")
        check(c.post("/api/catalogue/import", headers=H(tok), data={"shop": "Meestuffs"},
                     files={"file": ("x.csv", b"a,b\n1,2\n", "text/csv")}).status_code == 400, "other files refused")

        def msg(mid, frm, body=None, image=None):
            m = {"id": mid, "from": frm, "timestamp": str(int(time.time()))}
            if image:
                m.update({"type": "image", "image": {"id": image, "mime_type": "image/jpeg", **({"caption": body} if body else {})}})
            else:
                m.update({"type": "text", "text": {"body": body}})
            value = {"contacts": [{"wa_id": frm, "profile": {"name": "Cust"}}], "messages": [m]}
            assert c.post(hook, json={"object": "whatsapp_business_account", "entry": [{"changes": [{"field": "messages", "value": value}]}]}).status_code == 200

        def wait_reply(phone, n, timeout=25):
            end = time.time() + timeout
            while time.time() < end:
                if len([t for p, t in sent if p == phone]) >= n:
                    return [t for p, t in sent if p == phone]
                time.sleep(0.4)
            return [t for p, t in sent if p == phone]

        print("Screenshot of a keychain order (free OCR)")
        A = "919000000201"
        OCR_TEXT["MEDIA-A"] = "ORDER DETAILS\nOrder #357100000000000336\nSpecial Customised Doctor keychain with na\nFree Size"
        ai_calls.clear()
        msg("a1", A, image="MEDIA-A")
        replies = wait_reply(A, 1)
        check(replies and "name" in replies[-1].lower() and "charm" not in replies[-1].lower(),
              "asks only for the name (keychain: no charm)", replies)
        check("Order ID" not in replies[-1].split("\n")[0] or "send your Order ID" not in replies[-1], "doesn't ask for the Order ID it read", replies)
        check(not any(x.startswith("You read WhatsApp images") or x == server.SCREENSHOT_SYSTEM[:30] for x in ai_calls), "OCR found it: no AI vision call")
        th = c.get(f"/api/inbox/conversations/Shop M/{A}", headers=H(tok)).json()
        note = [m["ai_note"] for m in th["messages"] if m["kind"] == "image"][0]
        check(note.startswith("📷") and "357100000000000336" in note and "free OCR" in note, "note under the photo", note)
        o = [x for x in c.get("/api/orders", headers=H(tok)).json() if x.get("customer_phone") == A]
        check(len(o) == 1 and o[0]["order_id"] == "357100000000000336" and o[0]["source"] == "screenshot" and not o[0]["product_name"],
              "order saved straight away from the screenshot (before the name)", o)
        check(any(x["customer_phone"] == A for x in c.get("/api/inbox/conversations", headers=H(tok), params={"q": "357100000000000336"}).json()),
              "Chats search finds it by order ID")
        check(any(r["phone"] == A for r in c.get("/api/customer-data", headers=H(tok), params={"order_id": "357100000000000336"}).json()["rows"]),
              "Customer Data finds it")
        BOT_TURNS.append({"product_name": "Test Doctor Name", "action": "collect"})
        msg("a2", A, "Test Doctor Name")
        wait_reply(A, 2)
        o = [x for x in c.get("/api/orders", headers=H(tok)).json() if x.get("customer_phone") == A]
        check(len(o) == 1 and o[0]["order_id"] == "357100000000000336" and o[0]["product_name"] == "Test Doctor Name" and not o[0]["charm"]
              and o[0]["source"] == "whatsapp", "the same order filled in with the name (no duplicate)", o)
        ocr_before = len(ocr_calls)
        msg("a3", A, image="MEDIA-A2")
        time.sleep(3)
        check(len(ocr_calls) == ocr_before, "photo after the order is saved: not read")

        print("OCR finds nothing -> AI vision")
        B = "919000000202"
        VISION["MEDIA-B"] = {"order_page": True, "order_id": "357199999999999999", "product": "Customised Wallet for Men with Name & Charm Customization Blue ₹299"}
        msg("b1", B, image="MEDIA-B")
        replies = wait_reply(B, 1)
        check(replies and "charm" in replies[-1].lower(), "wallet: asks name + charm", replies)
        BOT_TURNS.append({"product_name": "Ravi", "action": "collect"})
        msg("b2", B, "Ravi")
        replies = wait_reply(B, 2)
        o = [x for x in c.get("/api/orders", headers=H(tok)).json() if x.get("customer_phone") == B]
        check(replies and "charm" in replies[-1].lower() and len(o) == 1 and o[0]["source"] == "screenshot",
              "name alone doesn't finish a wallet order: still asks the charm", (replies[-1:], o))
        th = c.get(f"/api/inbox/conversations/Shop M/{B}", headers=H(tok)).json()
        note = [m["ai_note"] for m in th["messages"] if m["kind"] == "image"][0]
        check("357199999999999999" in note and "₹" not in note and "299" not in note, "AI read it; the price is dropped", note)

        print("A photo that isn't an order page")
        C = "919000000203"
        msg("c1", C, image="MEDIA-SELFIE")
        time.sleep(4)
        check(not [t for p, t in sent if p == C], "no reply to a selfie")

        print("S- codes")
        D = "919000000204"
        BOT_TURNS.append({"action": "collect"})
        msg("d1", D, "S-400000001")
        replies = wait_reply(D, 1)
        check(replies and "not your Order ID" in replies[-1] and replies[-1].startswith("[guide picture]"), "explains + sends the Order ID picture", replies)
        check(not [x for x in c.get("/api/orders", headers=H(tok)).json() if x.get("customer_phone") == D], "S- code not saved")
        E = "919000000205"
        BOT_TURNS.append({"product_name": "Test Person", "charm": "31", "order_id": "s-400000001", "action": "collect"})
        msg("e1", E, "1.order id : s-400000001\n2 name on product: Test Person\n3.charm number :31")
        replies = wait_reply(E, 1)
        check(replies and "not your Order ID" in replies[-1], "S- code with other details: still asked for the real ID", replies)

        print("Combo: a name per item")
        F = "919000000206"
        OCR_TEXT["MEDIA-F"] = "Order #357111111111111111\nCustomised Wallet, Pen & Metal Keychain Combo Pack for Men\nmeesho"
        msg("f1", F, image="MEDIA-F")
        replies = wait_reply(F, 1)
        check(replies and "Wallet -" in replies[-1] and "Keychain -" in replies[-1] and "Pen -" in replies[-1], "asks a name for each item", replies)
        BOT_TURNS.append({"product_name": "Wallet: Aarav | Keychain: Riya | Pen: Dev", "charm": "5", "action": "collect"})
        msg("f2", F, "Wallet - Aarav\nKeychain - Riya\nPen - Dev\ncharm 5")
        wait_reply(F, 2)
        rows = [x for x in c.get("/api/orders", headers=H(tok)).json() if x.get("customer_phone") == F]
        by = {x["notes"].split(";")[0]: x for x in rows}
        check(len(rows) == 3 and {x["order_id"] for x in rows} == {"357111111111111111"}, "three rows, one order ID", rows)
        check(by["Item: Wallet"]["product_name"] == "Aarav" and by["Item: Wallet"]["charm"] == "5"
              and by["Item: Pen"]["product_name"] == "Dev" and not by["Item: Pen"]["charm"], "each item's name; charm only where it applies", by)
        check(server.label_status(["357111111111111111"], rows) == "matched", "one label for the combo")

        print("Keychain logo sent as a photo")
        G = "919000000207"
        OCR_TEXT["MEDIA-G"] = "Order #357122222222222222\nSpecial Customised Doctor keychain with name\nmeesho"
        msg("g1", G, image="MEDIA-G")
        wait_reply(G, 1)
        BOT_TURNS.append({"product_name": "AIIMS Delhi", "action": "collect"})
        msg("g2", G, image="MEDIA-LOGO")
        msg("g3", G, "AIIMS Delhi")  # logo and name sent together
        wait_reply(G, 2)
        rows = [x for x in c.get("/api/orders", headers=H(tok)).json() if x.get("customer_phone") == G]
        check(rows and rows[0]["charm"] == "logo: sent as image" and rows[0]["product_name"] == "AIIMS Delhi", "logo noted, no AI read it", rows)

        print("Label Studio: preview and removing a label's details")
        import pymupdf
        doc = pymupdf.open()
        for oid in ("357122222222222222_1", "111222333444_1"):
            pg = doc.new_page(width=595, height=842)
            pg.draw_rect(pymupdf.Rect(10, 10, 585, 335), color=(0, 0, 0), width=1)
            pg.insert_text((20, 300), "Product Details", fontsize=9)
            pg.insert_text((20, 328), f"0911-10  Free Size  1  Black  {oid}", fontsize=9)
        pdf = doc.tobytes()
        r = c.post("/api/pdf/preview", headers=H(tok), data={"page": "1", "details": json.dumps({"product_name": "Preview Name", "charm": "7"})},
                   files={"file": ("l.pdf", pdf, "application/pdf")})
        check(r.status_code == 200 and r.content[:8] == b"\x89PNG\r\n\x1a\n" and r.headers["content-type"] == "image/png", "preview is a picture of the page", r.status_code)
        check(c.post("/api/pdf/preview", headers=H(tok), data={"page": "9"}, files={"file": ("l.pdf", pdf, "application/pdf")}).status_code == 400,
              "a page that isn't in the PDF is refused")
        r = c.post("/api/pdf/annotate", headers=H(tok), data={"overrides": json.dumps({"1": "__none__"}), "engraving_list": "false"},
                   files={"file": ("l.pdf", pdf, "application/pdf")})
        out = pymupdf.open(stream=r.content, filetype="pdf")
        check(out.page_count == 2 and "CUSTOMISATION" not in out[0].get_text() and "ORDER NOT FOUND" not in out[0].get_text(),
              "removed details: page 1 prints without a box")
        check("ORDER NOT FOUND" in out[1].get_text(), "other pages unchanged")

        print("Engraving list page")
        # a Meesho-style label whose SKU is in the catalogue (a combo), a keychain order with a back side, and an unknown label
        server.CATALOGUE[:] = [dict(x, sku=("kZ3Hx7Hi" if x["title"].startswith("Customised Wallet, Pen") else "")) for x in server.CATALOGUE]
        c.post("/api/orders", headers=H(tok), json={"order_id": "357900000000000001_1", "product_name": "Rohan", "quantity": "2", "source": "manual"})
        c.patch(f"/api/orders/{[x for x in c.get('/api/orders', headers=H(tok)).json() if x['customer_phone'] == G][0]['id']}", headers=H(tok),
                json={"notes": "Other side: AIIMS 2026"})
        doc = pymupdf.open()
        def meesho_label(oid, sku, desc):
            pg = doc.new_page(width=595, height=842)
            y = 40
            for ln in ["Customer Address", "Test Customer", "Product Details", "SKU", "Size", "Qty", "Color", "Order No.",
                       sku, "Free Size", "1", "Black", oid, "TAX INVOICE", "Description", "HSN", "Qty", "Gross Amount", "Discount",
                       "Taxable Value", "Taxes", "Total", desc, "482010"]:
                pg.insert_text((20, y), ln, fontsize=8)
                y += 11
        meesho_label("357900000000000001_1", "kZ3Hx7Hi", "Some combo")                       # page 1: combo via SKU, qty 2
        meesho_label("357122222222222222_1", "zzz", "Special Customised Doctor keychain")     # page 2: keychain via description
        meesho_label("999999999999999999_1", "zzz", "Unknown thing")                          # page 3: no order
        r = c.post("/api/pdf/annotate", headers=H(tok), files={"file": ("labels.pdf", doc.tobytes(), "application/pdf")})
        out = pymupdf.open(stream=r.content, filetype="pdf")
        first = out[0].get_text()
        check(out.page_count == 4 and first.startswith("Engraving list"), "list page added in front of the 3 labels", out.page_count)
        check("1. GOLDEN STRIP" in first and "2. METAL PEN" in first and "3. METAL KEYCHAIN" in first, "the three categories", first[:400])
        check(first.count("Rohan") == 6, "combo name in golden strip, pen and keychain, twice each (quantity 2)", first)
        check("AIIMS Delhi" in first and "AIIMS 2026" in first and "p.2" in first, "two-sided keychain on one line, with its label number")
        check("NAME MISSING" in first and "999999999999999999_1" in first, "label without an order listed as missing")
        r = c.post("/api/pdf/annotate", headers=H(tok), data={"engraving_list": "false"}, files={"file": ("labels.pdf", doc.tobytes(), "application/pdf")})
        check(pymupdf.open(stream=r.content, filetype="pdf").page_count == 3, "switch off: no list page")

        print("Screenshot reader test button")

        async def running():
            return "running"
        server.ocr_health = running
        H2 = "919000000208"  # a customer who sent a screenshot but hasn't given a name yet: no order saved
        OCR_TEXT["MEDIA-H"] = "Order #357133333333333333\nPersonalised Name Wallet\nmeesho"
        VISION["MEDIA-H"] = {"order_page": True, "order_id": "357133333333333333", "product": "Personalised Name Wallet"}
        VISION["MEDIA-A"] = {"order_page": True, "order_id": "357100000000000999", "product": "keychain"}  # disagrees with OCR
        msg("h1", H2, image="MEDIA-H")
        wait_reply(H2, 1)
        asyncio.run(sql_exec(f'DELETE FROM "{SCHEMA}".wa_conversations WHERE customer_phone=$1', H2))
        asyncio.run(sql_exec(f'DELETE FROM "{SCHEMA}".orders WHERE customer_phone=$1', H2))  # as if read before this update
        asyncio.run(sql_exec(f"UPDATE \"{SCHEMA}\".wa_messages SET ai_note='' WHERE customer_phone=$1", H2))
        sent_before = len(sent)
        r = c.post("/api/screenshots/test", headers=H(tok), params={"limit": 20, "compare": "false"}).json()
        by = {x["phone"]: x for x in r["results"]}
        check(r["ocr_status"] == "running" and by["919000000201"]["ocr"]["order_id"] == "357100000000000336", "OCR results shown", by.get("919000000201"))
        check(by["919000000203"]["ocr"] is None and by["919000000203"]["ocr_note"], "photo without an order ID explained")
        check(not [x for x in c.get("/api/orders", headers=H(tok)).json() if x.get("customer_phone") == H2], "without the Haiku check: nothing saved")
        r = c.post("/api/screenshots/test", headers=H(tok), params={"limit": 20, "compare": "true"}).json()
        by = {x["phone"]: x for x in r["results"]}
        check(by[H2]["saved"] == "saved to customer data", "both agree: saved", by[H2])
        o = [x for x in c.get("/api/orders", headers=H(tok)).json() if x.get("customer_phone") == H2]
        check(len(o) == 1 and o[0]["order_id"] == "357133333333333333", "order ID now in the customer's data", o)
        check(by["919000000201"]["saved"] == "", "OCR and Haiku disagree: not saved", by["919000000201"])
        check(by["919000000206"]["saved"] in ("already saved", ""), "existing order not duplicated")
        check(len(sent) == sent_before, "no customer got a message")

    print(f"\nALL {passed} CHECKS PASSED")
finally:
    asyncio.run(drop_schema())
    print(f"(dropped test schema {SCHEMA})")
