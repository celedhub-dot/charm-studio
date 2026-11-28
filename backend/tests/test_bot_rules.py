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
said_by = {}  # phone -> texts it sent, so the fake AI answers the right chat even when replies run late


async def fake_claude(system, user, max_tokens=16000, effort=None, model=None):
    if system == server.BOT_TURN_SYSTEM:
        prompts.append(user)
        new = user.split("NEW customer message(s) to read", 1)[-1]
        # the chat whose own (longest) message is in this prompt; short common words ("Hi", "Thank you") prefer the latest chat
        score = {p: max((len(t) for t in texts if len(t) > 9 and t in new), default=0) for p, texts in said_by.items()}
        best = max(score.values(), default=0)
        owner = current_phone[0] if not best or score.get(current_phone[0]) == best else max(score, key=score.get)
        queue = BOT_TURNS.get(owner)
        if queue:
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


async def fake_chart(cfg, customer, caption):
    caption = f"{server.CHARM_CHART_NOTE}\n\n{caption}" if caption else server.CHARM_CHART_NOTE
    sent.append((customer, "[charm chart] " + caption))
    await server.record_message(cfg["logical_id"], customer, "out", "image", caption, None, "sent", "bot")
    await server.db().execute("UPDATE wa_contacts SET charm_chart_sent_at = now() WHERE number_label=$1 AND customer_phone=$2",
                              cfg["logical_id"], customer)
    return True


server.send_charm_chart = fake_chart
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
            if body:
                said_by.setdefault(frm, []).append(body.splitlines()[0][:60])
            m = {"id": mid, "from": frm, "timestamp": str(int(time.time()))}
            if image:
                m.update({"type": "image", "image": {"id": image, "mime_type": "image/jpeg"}})
            else:
                m.update({"type": "text", "text": {"body": body}})
            value = {"contacts": [{"wa_id": frm, "profile": {"name": "Cust"}}], "messages": [m]}
            assert c.post(hook, json={"object": "whatsapp_business_account", "entry": [{"changes": [{"field": "messages", "value": value}]}]}).status_code == 200

        def replies(phone):
            return [t for p, t in sent if p == phone]

        def wait_n(phone, n, timeout=60):
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
        check(r and "Order ID" in r[-1] and "charm" not in r[-1].lower(), "asks only for the Order ID (keychain from their words: no charm)",
              (r[-1:], c.portal.call(server.db().fetchrow, "SELECT bot_due_at, bot_since, bot_paused_at, now() FROM wa_contacts WHERE customer_phone=$1", G),
               c.portal.call(server.db().fetch, "SELECT customer_phone, bot_due_at FROM wa_contacts WHERE bot_due_at IS NOT NULL")))
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
        print("Charm chart")
        W = "919000000306"
        OCR_TEXT["MW"] = "Order #357700000000000123\nCustomised Wallet for Men with Name & Charm Customization Blue\nmeesho"
        BOT_TURNS[W] = [{"product_name": "Kabir", "action": "collect"}]
        msg("w1", W, image="MW")
        msg("w2", W, "Name Kabir")
        r = wait_n(W, 1)
        check(r[-1].startswith("[charm chart]") and server.CHARM_CHART_NOTE in r[-1] and "charm" in r[-1].lower(),
              "wallet: the charm question comes with the charm chart", r[-1:])
        BOT_TURNS[W] = [{"charm": "crown", "action": "collect"}]
        msg("w3", W, "crown")
        r = wait_n(W, 2)
        check("2, 3 or 4" in r[-1] and not orders(W)[0]["charm"], "'crown' fits 3 charms: asks which number", r[-1:])
        BOT_TURNS[W] = [{"action": "collect"}]
        msg("w4", W, "3")
        r = wait_n(W, 3)
        check(orders(W)[0]["charm"] == "3 (Crown)" and "saved" in r[-1].lower(), "'3' saves '3 (Crown)'", (orders(W), r[-1:]))
        check(sum(x.startswith("[charm chart]") for x in replies(W)) == 1, "chart sent once with the question")
        msg("w5", W, "what is charm? show options")
        r = wait_n(W, 4)
        check(r[-1].startswith("[charm chart]"), "'what is charm / options' sends the chart again", r[-1:])
        time.sleep(4)
        O = "919000000307"
        BOT_TURNS[O] = [{"order_id": "357800000000000321", "product_name": "Shiv", "charm": "Om", "action": "collect"}]
        msg("o1", O, "357800000000000321 wallet name Shiv, Om charm")
        wait_n(O, 1)
        check(orders(O) and orders(O)[0]["charm"] == "52 (Om)", "'Om' saved as '52 (Om)'", orders(O))
        BOT_TURNS[O] = [{"action": "silent"}]
        msg("o2", O, "This is the wrong charm, not this")
        r = wait_n(O, 2)
        check(r[-1].startswith("[charm chart]") and "number 52 is Om" in r[-1] and "send its number" in r[-1],
              "a doubt about the charm: tells the chart's name for their number, with the chart", r[-1:])
        BOT_TURNS[O] = [{"charm": "46", "action": "collect"}]
        msg("o3", O, "46")
        r = wait_n(O, 3)
        check(orders(O)[0]["charm"] == "46 (Red heart)" and "Charm: 46 (Red heart)" in r[-1], "a new number updates the charm", (orders(O), r[-1:]))

        time.sleep(4)
        print("Keychain only: a combo listing never adds a wallet")
        server.CATALOGUE.append({"title": "Wallet Key Chain Combo STEP 1:-Place Your Order On Meesho", "sku": "WKC-TEST"})
        needs, name = server.product_needs("On keychain", from_words=True)
        check(needs["items"] == [] and "Wallet" not in name, "'On keychain' (their words) is not matched to the wallet combo", (needs, name))
        K = "919000000308"
        BOT_TURNS[K] = [{"order_id": "OD100000000000000001", "action": "collect"},
                        {"product_name": "Dr. Test", "action": "collect"}, {"action": "collect"}]
        msg("k1", K, "OD100000000000000001 my order ID from Flipkart")
        wait_n(K, 1)
        msg("k2", K, "Name - Dr. Test")
        wait_n(K, 2)
        msg("k3", K, "On keychain")
        r = wait_n(K, 3)
        time.sleep(3)
        check(not [x for x in replies(K) if "Wallet" in x], "never asks for a wallet name", replies(K))
        V = "919000000309"
        BOT_TURNS[V] = [{"order_id": "OD100000000000000002", "action": "collect"},
                        {"product_name": "Keychain: Dr. Test", "action": "collect"}, {"action": "collect"}]
        msg("v1", V, "OD100000000000000002 wallet keychain combo")
        wait_n(V, 1)
        msg("v2", V, "Keychain - Dr. Test")
        r = wait_n(V, 2)
        check("Wallet" in r[-1], "a real combo: asks for the wallet name", r[-1:])
        msg("v3", V, "I ordered only key chain")
        r = wait_n(V, 3)
        time.sleep(3)
        o = orders(V)
        check("Wallet" not in replies(V)[-1] and o and o[0]["product_name"] == "Dr. Test",
              "'I ordered only key chain' drops the wallet and keeps the keychain name", (o, replies(V)[-1:]))
        server.CATALOGUE.pop()

        time.sleep(4)
        print("A keychain without a charm: no 'Charm:' line, no charm saved later")
        N = "919000000310"
        BOT_TURNS[N] = [{"order_id": "357900000000000111", "product_name": "Test Saheb", "action": "collect"}]
        msg("n1", N, "357900000000000111 CA name keychain, Name: Test Saheb")
        r = wait_n(N, 1)
        check("saved" in r[-1].lower() and "Charm" not in r[-1], "saved summary has no 'Charm:' line for a no-charm product", r[-1:])
        msg("n2", N, "Charm means")
        r = wait_n(N, 2)
        check(r[-1] == server.NO_CHARM_REPLY, "'Charm means' on a no-charm product: says it takes no charm", r[-1:])
        BOT_TURNS[N] = [{"charm": "2721", "action": "collect"}]
        msg("n3", N, "2721")
        r = wait_n(N, 3)
        check(not orders(N)[0]["charm"] and r[-1] == server.NO_CHARM_REPLY, "a number sent later is not saved as a charm", (orders(N), r[-1:]))
        Y = "919000000312"
        BOT_TURNS[Y] = [{"order_id": "357900000000000333", "product_name": "Arun", "action": "collect"}, {"action": "collect"}]
        msg("y1", Y, "357900000000000333 Name-Arun")
        r = wait_n(Y, 1)
        check("screenshot of this order" in r[-1] and "charm" not in r[-1].lower() and not r[-1].startswith("[charm chart]"),
              "product unknown: asks for the order screenshot before any charm (no chart)", r[-1:])
        msg("y2", Y, "Kada")
        r = wait_n(Y, 2)
        o = orders(Y)
        check(o and not o[0]["charm"] and "saved" in r[-1].lower(), "'Kada': saved with no charm", (o, r[-1:]))
        print("Doctor / advocate keychains: never a charm")
        D = "919000000313"
        BOT_TURNS[D] = [{"order_id": "357900000000000444", "product_name": "Dr. Testname", "action": "collect"}]
        msg("d1", D, "357900000000000444\nDr. Testname")
        r = wait_n(D, 1)
        check("saved" in r[-1].lower() and "Charm" not in r[-1] and "charm" not in r[-1].lower(),
              "name 'Dr. Testname' (product unknown): saved, no charm question", r[-1:])
        msg("d2", D, "What charm and notes means")
        r = wait_n(D, 2)
        check(r[-1] == server.NO_CHARM_REPLY, "asking what charm means: told it takes no charm (no chart)", r[-1:])
        E = "919000000314"
        BOT_TURNS[E] = [{"order_id": "357900000000000555", "product_name": "Priya", "charm": "Doctor symbol", "action": "collect"}]
        msg("e1", E, "357900000000000555 Doctor symbol with name Priya")
        r = wait_n(E, 1)
        o = orders(E)
        check(o and not o[0]["charm"] and "saved" in r[-1].lower(), "'Doctor symbol with name': no charm saved", (o, r[-1:]))
        F = "919000000315"
        BOT_TURNS[F] = [{"order_id": "357900000000000666", "action": "collect"}, {"product_name": "Adv. Demoname", "action": "collect"}]
        msg("f1", F, "357900000000000666")
        wait_n(F, 1)
        msg("f2", F, "Adv. Demoname")
        r = wait_n(F, 2)
        check("saved" in r[-1].lower() and "charm" not in r[-1].lower() and orders(F) and not orders(F)[0]["charm"],
              "'Adv. Demoname' after the ID: saved, no charm", (orders(F), r[-1:]))
        G2 = "919000000316"
        BOT_TURNS[G2] = [{"order_id": "357900000000000777", "product_name": "Dr. Mehta", "charm": "46", "action": "collect"}]
        msg("g21", G2, "357900000000000777 wallet, name Dr. Mehta, charm 46")
        wait_n(G2, 1)
        check(orders(G2) and orders(G2)[0]["charm"] == "46 (Red heart)", "a Dr. ordering a wallet with a charm keeps the charm", orders(G2))
        print("One platform per number; the screenshot first")
        check(server.platform_of("Meestuffs Meesho") == "Meesho" and server.platform_of("Meestuffs Flipkart") == "Flipkart"
              and server.platform_of("Order desk") == "", "the number's name tells the platform")
        tok_p = server.chat_platform.set("Meesho")
        check("Meesho order details page" in server.bot_question(0) and "Flipkart" not in server.bot_question(0),
              "Meesho number: asks for the Meesho order screenshot only", server.bot_question(0))
        check(server.one_platform("Find it in your Meesho or Flipkart app") == "Find it in your Meesho app", "Meesho number: never says 'or Flipkart'")
        server.chat_platform.set("Flipkart")
        check("Flipkart order details page" in server.bot_question(0) and server.one_platform("on Meesho/Flipkart") == "on Flipkart",
              "Flipkart number: Flipkart only")
        server.chat_platform.reset(tok_p)
        check("Meesho or Flipkart" in server.bot_question(0), "other numbers mention both")
        Q = "919000000317"
        BOT_TURNS[Q] = [{"order_id": "357900000000000888", "action": "collect"}, {"action": "collect"}]
        msg("q1", Q, "357900000000000888")
        r = wait_n(Q, 1)
        check("screenshot of this order" in r[-1], "typed ID, product unknown: asks once more for the screenshot", r[-1:])
        o = orders(Q)
        check(len(o) == 1 and o[0]["order_id"] == "357900000000000888" and o[0]["source"] == "pending",
              "a typed Order ID is in Orders straight away, marked in progress", o)
        msg("q2", Q, "I don't have it")
        r = wait_n(Q, 2)
        check(server.PRODUCT_QUESTION in r[-1] and "screenshot" not in r[-1], "then asks which product (screenshot asked only once)", r[-1:])

        print("Typed ID, then the screenshot the bot asked for")
        M2 = "919000000320"
        BOT_TURNS[M2] = [{"order_id": "357900000000002222", "product_name": "Test Khan", "action": "collect"}, {"action": "collect"}]
        msg("m21", M2, "#357900000000002222\nTest Khan")
        r = wait_n(M2, 1)
        check("screenshot of this order" in r[-1] and orders(M2) and orders(M2)[0]["product_name"] == "Test Khan",
              "typed ID + name: saved in progress, asks for the screenshot", (orders(M2), r[-1:]))
        OCR_TEXT["MP"] = "Order #357900000000002222\nCustomised Glitered Pen with Name\nmeesho"
        msg("m22", M2, image="MP")
        r = wait_n(M2, 2)
        o = orders(M2)
        check(len(o) == 1 and o[0]["source"] == "whatsapp" and o[0]["product_name"] == "Test Khan" and not o[0]["charm"]
              and "saved" in r[-1].lower(), "the screenshot is read even though the ID was typed: pen known, saved, no charm",
              (o, r[-1:], c.portal.call(server.db().fetch, "SELECT kind, ai_note, media_id FROM wa_messages WHERE customer_phone=$1 AND direction='in'", M2),
               c.portal.call(server.db().fetchval, "SELECT fields FROM wa_conversations WHERE customer_phone=$1", M2),
               c.portal.call(server.chat_needs_product, "Shop M", M2)))
        S2 = "919000000321"
        BOT_TURNS[S2] = [{"order_id": "358100000000001111", "product_name": "Anshi", "action": "collect"}, {"action": "silent"}]
        msg("s21", S2, "Order I'd 358100000000001111\nName anshi")
        wait_n(S2, 1)
        msg("s22", S2, "Kangan size 2 by 14")
        r = wait_n(S2, 2)
        o = orders(S2)
        check(o and o[0]["source"] == "whatsapp" and not o[0]["charm"] and "saved" in r[-1].lower() and "charm" not in r[-1].lower(),
              "'Kangan' names the product (a kada): saved even though the AI stayed quiet, no charm", (o, r[-1:]))
        print("Bot pause in one chat")
        Z = "919000000318"
        BOT_TURNS[Z] = [{"action": "collect"}]
        msg("z1", Z, "Hi")
        wait_n(Z, 1)
        r = c.post(f"/api/inbox/conversations/Shop%20M/{Z}/bot-pause", headers=H(tok), json={"paused": True})
        check(r.status_code == 200 and r.json()["bot_paused_at"], "staff pause the bot in a chat", r.text[:200])
        n = len(replies(Z))
        BOT_TURNS[Z] = [{"order_id": "357900000000000999", "action": "collect"}]
        msg("z2", Z, "357900000000000999")
        check(len(settle(Z, 6)) == n, "paused: the bot sends nothing")
        r = c.post(f"/api/inbox/conversations/Shop%20M/{Z}/bot-pause", headers=H(tok), json={"paused": False})
        check(r.status_code == 200 and r.json()["bot_paused_at"] is None, "resumed")
        BOT_TURNS[Z] = [{"product_name": "Ravi", "action": "collect"}]
        msg("z3", Z, "Name Ravi")
        r = wait_n(Z, n + 1)
        check(len(r) > n, "after resuming, the bot replies again", r[-1:])
        X = "919000000311"
        BOT_TURNS[X] = [{"order_id": "357900000000000222", "product_name": "Riya", "charm": "46", "action": "collect"}]
        msg("x1", X, "357900000000000222 wallet name Riya charm 46")
        wait_n(X, 1)
        BOT_TURNS[X] = [{"charm": "2721", "action": "collect"}]
        msg("x2", X, "change charm to 2721")
        r = wait_n(X, 2)
        check(orders(X) and orders(X)[0]["charm"] == "46 (Red heart)" and r[-1:] == [server.OFF_CHART_REPLY], "a number not on the chart (2721) is refused", (orders(X), r[-1:]))

        time.sleep(4)
        print("Combo: names and charms per item, caption, extra charms")
        K2 = "919000000319"
        BOT_TURNS[K2] = [{"order_id": "357900000000001111", "action": "collect"}]
        msg("k21", K2, "357900000000001111 wallet and passport cover combo")
        r = wait_n(K2, 1)
        check(server.COMBO_NAME_QUESTION in r[-1] and "Wallet -" in r[-1] and "Passport cover -" in r[-1],
              "combo: asks one name for all, or a name for each", r[-1:])
        BOT_TURNS[K2] = [{"product_name": "Aarav", "caption": "Happy journey", "charm": "Wallet: 52 | Passport cover: 46, 9, 5, 3",
                          "action": "collect"}]
        msg("k22", K2, "Aarav on both. Wallet charm 52, passport cover charms 46 9 5 3, caption Happy journey")
        r = wait_n(K2, 2)
        rows = {(o["notes"] or "").split(";")[0]: o for o in orders(K2)}
        w, pc = rows.get("Item: Wallet"), rows.get("Item: Passport cover")
        check(w and pc and w["product_name"] == pc["product_name"] == "Aarav", "one name saved on both items", rows)
        check(w["charm"] == "52 (Om)" and pc["charm"] == "46 (Red heart), 9 (Doctor symbol), 5 (Infinity love)"
              and pc["extra_charms"] == "3 (Crown)" and pc["caption"] == "Happy journey" and not w["caption"],
              "each item its own charms; caption passport cover: 3 free, the 4th waits for payment", (w, pc))
        check(server.EXTRA_CHARM_NOTE in r[-1] and "Caption: Happy journey" in r[-1], "the reply mentions the Rs 20 extra charm and the caption", r[-1:])

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
