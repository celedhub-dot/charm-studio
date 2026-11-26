"""The bot's rules, replayed on two real conversation patterns (made-up numbers, names and IDs):
- once an order is saved, later messages update it / get answered / stay quiet: never a restart or an ID request
- the Order ID example picture goes at most once per customer, labelled as an example
- an Order ID typed by staff counts; the product can come from the customer's words; no charm for keychains
- "add CA as prefix" updates the name

    cd backend
    .venv/Scripts/python.exe tests/test_bot_rules.py
"""
import asyncio
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

SCHEMA = "charm_test_rules"
os.environ.update({"DB_SCHEMA": SCHEMA, "AUTH_SECRET": secrets.token_urlsafe(48), "ADMIN_PASSWORD": "legacy-pass-123",
                   "RESET_PASSWORD": "", "WA_NUMBERS": "", "ANTHROPIC_API_KEY": "sk-ant-test-not-real", "AI_PROVIDER": "anthropic",
                   "BOT_REPLY_WAIT_SECONDS": "1", "READ_DEBOUNCE_SECONDS": "1", "PUBLIC_BASE_URL": "https://api.example.test",
                   "OCR_URL": "https://ocr.example.test", "OCR_KEY": "test-ocr-key"})


async def drop_schema():
    conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
    await conn.execute(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE')
    await conn.close()


asyncio.run(drop_schema())

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

sent = []
OCR_TEXT = {}
BOT_TURNS = {}  # phone -> list of AI answers, in order
prompts = []


async def fake_send(cfg, to, text, source="bot"):
    sent.append((to, text))
    await server.record_message(cfg["logical_id"], to, "out", "text", text, None, "sent", source)


async def fake_guide(cfg, customer, caption):
    caption = f"{server.GUIDE_NOTE}\n\n{caption}"
    sent.append((customer, "[guide picture] " + caption))
    await server.record_message(cfg["logical_id"], customer, "out", "image", caption, None, "sent", "bot")
    await server.db().execute("UPDATE wa_contacts SET guide_sent_at = now() WHERE number_label=$1 AND customer_phone=$2",
                              cfg["logical_id"], customer)
    return True


async def fake_fetch(cfg, media_id):
    return media_id.encode(), "image/jpeg"


async def fake_ocr(data):
    return OCR_TEXT.get(data.decode(), "")


current_phone = [""]


async def fake_claude(system, user, max_tokens=16000, effort=None, model=None):
    if system == server.BOT_TURN_SYSTEM:
        prompts.append(user)
        for phone, queue in BOT_TURNS.items():
            if queue and phone == current_phone[0]:
                return json.dumps(queue.pop(0))
        return json.dumps({"action": "silent"})
    if system == server.SCREENSHOT_SYSTEM:
        return json.dumps({"order_page": False})
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


try:
    with TestClient(server.app) as c:
        tok = c.post("/api/auth/login", json={"password": "legacy-pass-123"}).json()["token"]
        tok = c.post("/api/account/setup", headers=H(tok), json={"name": "Owner", "email": "o@x.test", "password": "mango-river-42"}).json()["token"]
        num = c.post("/api/wa/numbers", headers=H(tok), json={"label": "Shop M", "provider": "360dialog", "phone_id": "918339039324",
                                                               "token": "d360-test-key-0123456789ABCD"}).json()
        c.patch(f"/api/wa/numbers/{num['id']}", headers=H(tok), json={"bot_mode": "ask"})
        hook = num["webhook_url"].replace("https://api.example.test", "")

        def msg(mid, frm, body=None, image=None):
            current_phone[0] = frm
            m = {"id": mid, "from": frm, "timestamp": str(int(time.time()))}
            if image:
                m.update({"type": "image", "image": {"id": image, "mime_type": "image/jpeg"}})
            else:
                m.update({"type": "text", "text": {"body": body}})
            value = {"contacts": [{"wa_id": frm, "profile": {"name": "Cust"}}], "messages": [m]}
            assert c.post(hook, json={"object": "whatsapp_business_account", "entry": [{"changes": [{"field": "messages", "value": value}]}]}).status_code == 200

        def replies(phone):
            return [t for p, t in sent if p == phone]

        def wait_n(phone, n, timeout=20):
            end = time.time() + timeout
            while time.time() < end and len(replies(phone)) < n:
                time.sleep(0.3)
            return replies(phone)

        def settle(phone, seconds=3.5):
            time.sleep(seconds)
            return replies(phone)

        def orders(phone):
            return [o for o in c.get("/api/orders", headers=H(tok)).json() if o.get("customer_phone") == phone]

        print("Pattern 1: screenshot, name, then 'make it beautiful' / 'thank you' after saving")
        A = "919000000301"
        msg("a1", A, "Hi")
        r = wait_n(A, 1)
        check(r[0].startswith("[guide picture]") and server.GUIDE_NOTE in r[0], "first contact: example picture, labelled as an example", r)
        OCR_TEXT["MA"] = "Order #357400000000000456\nSpecial Customised Doctor keychain with name\nmeesho"
        BOT_TURNS[A] = [{"product_name": "Dr.Harsh", "notes": "Print on keychain", "action": "collect"}]
        msg("a2", A, image="MA")
        msg("a3", A, "Name Dr.Harsh")
        msg("a4", A, "On key chain should be printed")
        r = wait_n(A, 2)
        o = orders(A)
        check(len(o) == 1 and o[0]["product_name"] == "Dr.Harsh" and not o[0]["charm"] and "saved" in r[-1].lower(),
              "saved from the screenshot + name, no charm asked for a keychain", (r[-1], o))
        BOT_TURNS[A] = [{"notes": "Please make it beautiful", "action": "collect"}]
        msg("a5", A, "Please make it beautiful")
        msg("a6", A, "Thank you")
        r = wait_n(A, 3)
        check(r[-1].startswith("Updated your order 357400000000000456") and "make it beautiful" in r[-1], "the instruction is added to the saved order", r[-1])
        check(sum(x.startswith("[guide picture]") for x in r) == 1 and "send your Order ID" not in r[-1], "no restart, no ID request, no second picture")
        check("make it beautiful" in orders(A)[0]["notes"] and "Print on keychain" in orders(A)[0]["notes"], "notes kept and added to", orders(A)[0]["notes"])
        n = len(replies(A))
        msg("a7", A, "Thank you")
        check(len(settle(A)) == n, "a later 'thank you': no reply")
        msg("a8", A, "On key chain should be printed")
        msg("a9", A, "Name Dr.Harsh")
        r = settle(A, 4)
        check(not [x for x in r[n:] if "Order ID" in x or x.startswith("[guide picture]")], "repeating details after saving: never asks for the ID again", r[n:])
        check(len(orders(A)) == 1, "still one order")

        time.sleep(6)  # let the first chat's last replies finish before the next scenario
        print("Pattern 2: product named in words, ID typed by staff, prefix request after saving")
        G = "919000000302"
        BOT_TURNS[G] = [{"product_name": "CA GNANESHWARAN", "action": "collect"}]
        msg("g1", G, "Hi")
        msg("g2", G, "I ordered customized name in CA keychain")
        msg("g3", G, "NAME: CA GNANESHWARAN")
        r = wait_n(G, 1)
        check("Order ID" in r[-1] and "charm" not in r[-1].lower(), "asks only for the Order ID (keychain from their words: no charm)", r[-1])
        asyncio.run(asyncio.sleep(0))
        c.portal.call(server.record_message, "Shop M", G, "out", "text", "357200000000009488", None, "sent", "staff")  # staff typed the ID
        BOT_TURNS[G] = [{"notes": "Other side: OPPORTUNITY COST", "action": "collect"}]
        msg("g4", G, "I want name on one side and on another side I need ' OPPORTUNITY COST'")
        r = wait_n(G, 3)
        o = orders(G)
        check(len(o) == 1 and o[0]["order_id"] == "357200000000009488" and o[0]["product_name"] == "CA GNANESHWARAN"
              and not o[0]["charm"] and "OPPORTUNITY COST" in o[0]["notes"], "uses the ID your staff typed; saved with the note, no charm", o)
        n = len(replies(G))
        BOT_TURNS[G] = [{"action": "silent"}]
        msg("g5", G, "With a  name add CA as prefix")
        r = settle(G, 4)
        check(not [x for x in r[n:] if x.startswith("[guide picture]") or "Order ID" in x], "prefix request after saving: no restart", r[n:])
        check(orders(G)[0]["product_name"] == "CA GNANESHWARAN", "name already starts with CA: unchanged")
        BOT_TURNS[G] = [{"action": "answer", "reply": "The picture we sent was only an example of where to find the Order ID. Your CA keychain order is saved."}]
        msg("g6", G, "This is not which I ordered sir")
        r = wait_n(G, n + 1)
        check("only an example" in r[-1] and "send your Order ID" not in r[-1], "a confused customer gets an answer, not the intake again", r[-1])
        check(sum(x.startswith("[guide picture]") for x in replies(G)) == 1, "example picture sent once in the whole chat", replies(G))

        time.sleep(5)
        print("Prefix rule")
        P = "919000000303"
        BOT_TURNS[P] = [{"order_id": "357300000000000001", "product_name": "Riya Sharma", "action": "collect"}]
        msg("p1", P, "Order 357300000000000001 keychain, name Riya Sharma")
        wait_n(P, 1)
        BOT_TURNS[P] = [{"action": "silent"}]
        msg("p2", P, "please add Dr. as prefix")
        r = wait_n(P, 2)
        check(orders(P)[0]["product_name"] == "Dr. Riya Sharma" and "Name: Dr. Riya Sharma" in r[-1], "'add Dr. as prefix' updates the name", (orders(P), r[-1:]))

        time.sleep(4)
        print("Junk charms and # in order IDs")
        J = "919000000304"
        BOT_TURNS[J] = [{"order_id": "#357500000000000777", "product_name": "Meena", "charm": "Not applicable", "action": "collect"}]
        msg("j1", J, "Order id: #357500000000000777 name Meena, charm not applicable")
        r = wait_n(J, 1)
        o = orders(J)
        check(len(o) == 1 and o[0]["order_id"] == "357500000000000777" and not o[0]["charm"] and "charm" not in r[-1].split("Charm:")[0].lower(),
              "'not applicable' isn't saved as a charm and the # is dropped from the ID", (o, r[-1:]))
        K = "919000000305"
        BOT_TURNS[K] = [{"order_id": "357600000000000888", "product_name": "Asha", "action": "collect"},
                        {"charm": "Keychain", "action": "collect"}]
        msg("k1", K, "357600000000000888 name Asha")
        wait_n(K, 1)
        msg("k2", K, "Keychain")
        r = wait_n(K, 2)
        o = orders(K)
        check(len(o) == 1 and o[0]["charm"] == "" and "saved" in r[-1].lower(), "answering 'Keychain' to the charm question: no charm, order saved", (o, r[-1:]))

        time.sleep(4)
        print("Shop facts reach the AI")
        c.put("/api/settings/bot", headers=H(tok), json={**{k: v for k, v in server.DEFAULT_SETTINGS["bot"].items() if k != "knowledge"},
                                                          "knowledge": "We print on both sides of metal keychains."})
        prompts.clear()
        BOT_TURNS[P] = [{"action": "answer", "reply": "Yes, we print on both sides."}]
        msg("p3", P, "Do you print name on both sides of keychain?")
        r = wait_n(P, 3)
        check(any("We print on both sides of metal keychains." in x for x in prompts) and r[-1] == "Yes, we print on both sides.",
              "the bot is given your shop facts and answers", r[-1])

    print(f"\nALL {passed} CHECKS PASSED")
finally:
    asyncio.run(drop_schema())
    print(f"(dropped test schema {SCHEMA})")
