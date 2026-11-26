"""Group chats copied from the phone app: shown in Chats (pinned, with each sender), read-only, and the bot
never reads or replies there. Made-up numbers only.

Runs the real app against a throwaway Postgres schema ("charm_test_groups"); WhatsApp and the AI are faked.

    cd backend
    .venv/Scripts/python.exe tests/test_groups.py
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

SCHEMA = "charm_test_groups"
os.environ.update({"DB_SCHEMA": SCHEMA, "AUTH_SECRET": secrets.token_urlsafe(48), "ADMIN_PASSWORD": "legacy-pass-123",
                   "RESET_PASSWORD": "", "WA_NUMBERS": "", "ANTHROPIC_API_KEY": "", "AI_PROVIDER": "anthropic",
                   "BOT_REPLY_WAIT_SECONDS": "2", "READ_DEBOUNCE_SECONDS": "1", "PUBLIC_BASE_URL": "https://api.example.test"})


async def sql(*statements):
    conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
    try:
        for s in statements:
            if isinstance(s, tuple):
                await conn.execute(s[0], *s[1:])
            else:
                await conn.execute(s)
    finally:
        await conn.close()


asyncio.run(sql(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE'))

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

sent, ai_calls = [], []


async def fake_send(cfg, to, text, source="bot"):
    sent.append((to, text))
    await server.record_message(cfg["logical_id"], to, "out", "text", text, None, "sent", source)


async def fake_set_webhook(api_key, url):
    return None


async def fake_claude(*a, **k):
    ai_calls.append(a[:1])
    return "[]"


server.send_wa = fake_send
server.d360_set_webhook = fake_set_webhook
server.claude_text = fake_claude
passed = 0


def check(cond, label, extra=""):
    global passed
    if not cond:
        raise AssertionError(f"FAILED: {label} {extra}")
    passed += 1
    print(f"  ok  {label}")


def H(t):
    return {"Authorization": f"Bearer {t}"}


GROUP = "g-120363000000000001"
NOW = datetime.now(timezone.utc)

try:
    check(server.is_group_chat(GROUP) and not server.is_group_chat("919000000081"), "group keys can't be mistaken for numbers")
    with TestClient(server.app) as c:
        tok = c.post("/api/auth/login", json={"password": "legacy-pass-123"}).json()["token"]
        tok = c.post("/api/account/setup", headers=H(tok), json={"name": "Owner", "email": "o@x.test", "password": "mango-river-42"}).json()["token"]
        a = c.post("/api/wa/numbers", headers=H(tok), json={"label": "Shop A", "provider": "360dialog", "phone_id": "918339039324", "token": "d360-test-key-0123456789ABCD"}).json()
        c.patch(f"/api/wa/numbers/{a['id']}", headers=H(tok), json={"bot_mode": "read"})
        hook = a["webhook_url"].replace("https://api.example.test", "")
        c.post("/api/saved-contacts", headers=H(tok), json={"phone": "919000000082", "name": "Team Member"})

        q = f'"{SCHEMA}".'
        asyncio.run(sql(
            (f"INSERT INTO {q}wa_contacts (number_label, customer_phone, name, last_preview, last_message_at, unread, chat_kind, pinned_at) "
             "VALUES ('Shop A',$1,'Order Group','My order 346654813867976704_1',$2,0,'group',$2)", GROUP, NOW - timedelta(days=2)),
            (f"INSERT INTO {q}wa_contacts (number_label, customer_phone, name, last_preview, last_message_at, unread) "
             "VALUES ('Shop A','919000000083','Customer','hi',$1,0)", NOW),
            (f"UPDATE {q}wa_contacts SET last_inbound_at = now() - interval '1 hour' WHERE customer_phone = '919000000083'"),
            (f"INSERT INTO {q}wa_messages (id, number_label, customer_phone, direction, kind, body, status, source, error, created_at, sender) VALUES "
             "('gm1','Shop A',$1,'in','text','My order 346654813867976704_1, name AARAV','received','customer','',$2,'919000000081'),"
             "('gm2','Shop A',$1,'in','text','Packed','received','customer','',$3,'919000000082'),"
             "('gm3','Shop A',$1,'out','text','Thanks','sent','phone_app','',$4,''),"
             "('gm4','Shop A',$1,'in','text','Noted','received','customer','',$4,'Phone Contact')",
             GROUP, NOW - timedelta(days=2, minutes=3), NOW - timedelta(days=2, minutes=2), NOW - timedelta(days=2, minutes=1)),
        ))

        print("Shown in Chats")
        convs = c.get("/api/inbox/conversations", headers=H(tok)).json()
        check(convs[0]["customer_phone"] == GROUP and convs[0]["chat_kind"] == "group", "group pinned above a newer chat", [x["customer_phone"] for x in convs])
        th = c.get(f"/api/inbox/conversations/Shop A/{GROUP}", headers=H(tok)).json()
        ms = {m["id"]: m for m in th["messages"]}
        check(ms["gm1"]["sender"] == "919000000081" and ms["gm1"]["sender_name"] == "", "each message keeps its sender's number")
        check(ms["gm2"]["sender_name"] == "Team Member", "a saved contact's name is shown instead of the number")
        check(th["orders"] == [], "no orders panel for a group")
        check(ms["gm4"]["sender_name"] == "Phone Contact", "a sender name copied from the phone shows as it is")

        print("Bot and AI stay out")
        rr = c.post(f"/api/inbox/conversations/Shop A/{GROUP}/read-orders", headers=H(tok)).json()
        check(rr.get("group") and rr["orders"] == [] and not ai_calls, "Read chat refuses, no AI call", rr)
        value = {"contacts": [{"wa_id": "919000000081", "profile": {"name": "Member"}}],
                 "messages": [{"id": "gw1", "from": "919000000081", "group_id": "120363000000000001", "type": "text",
                               "timestamp": str(int(time.time())), "text": {"body": "order 346654813867976704_1"}}]}
        assert c.post(hook, json={"object": "whatsapp_business_account", "entry": [{"changes": [{"field": "messages", "value": value}]}]}).status_code == 200
        time.sleep(6)  # longer than the read wait (1 s in this test)
        check(not ai_calls and not sent, "a message that arrives from a group never reaches the bot", (ai_calls, sent))

        print("Read-only")
        r = c.post("/api/inbox/send", headers=H(tok), json={"number_label": "Shop A", "to": GROUP, "text": "hello"})
        check(r.status_code == 400 and "read-only" in r.json()["detail"], "typed reply refused", r.text)
        r = c.post("/api/inbox/send-media", headers=H(tok), data={"number_label": "Shop A", "to": GROUP, "caption": ""},
                   files={"file": ("a.pdf", b"%PDF-1.4", "application/pdf")})
        check(r.status_code == 400, "file refused", r.text)
        r = c.post("/api/inbox/send-template", headers=H(tok), json={"number_label": "Shop A", "to": GROUP, "name": "x", "language": "en"})
        check(r.status_code in (400, 422), "template refused", r.text)
        check(not sent, "nothing sent to WhatsApp")
        r = c.patch(f"/api/inbox/conversations/Shop A/{GROUP}", headers=H(tok), json={"saved": True})
        check(r.status_code == 400, "a group can't be marked as a saved contact")
        r = c.patch(f"/api/inbox/conversations/Shop A/{GROUP}", headers=H(tok), json={"pinned": False})
        check(r.status_code == 200 and r.json()["pinned_at"] is None, "can still be unpinned")

        print("Reply window")
        c2 = [x for x in c.get("/api/inbox/conversations", headers=H(tok)).json() if x["customer_phone"] == "919000000083"][0]
        check(not c2["window_open"], "history copied from the phone doesn't open WhatsApp's 24-hour window")
        value = {"contacts": [{"wa_id": "919000000083", "profile": {"name": "Customer"}}],
                 "messages": [{"id": "rw1", "from": "919000000083", "type": "text", "timestamp": str(int(time.time())), "text": {"body": "hello"}}]}
        c.post(hook, json={"object": "whatsapp_business_account", "entry": [{"changes": [{"field": "messages", "value": value}]}]})
        c2 = [x for x in c.get("/api/inbox/conversations", headers=H(tok)).json() if x["customer_phone"] == "919000000083"][0]
        check(c2["window_open"], "a message that reaches WhatsApp's API opens it")

        print("Team chat in a group")
        r = c.post(f"/api/team/Shop A/{GROUP}/post", headers=H(tok), json={"text": "Packing list for today"})
        check(r.status_code == 200, "owner posts in the group", r.text)
        post = [m for m in r.json()["messages"] if m["source"] == "team"][-1]
        check(post["body"] == "Packing list for today" and post["sender"] == "Owner" and post["status"] == "team", "saved as a team post with the poster's name", post)
        check(not sent, "nothing sent on WhatsApp")
        r = c.post(f"/api/team/Shop A/{GROUP}/file", headers=H(tok), data={"caption": "labels"},
                   files={"file": ("labels.pdf", b"%PDF-1.4 test", "application/pdf")})
        f = [m for m in r.json()["messages"] if m["source"] == "team"][-1]
        check(r.status_code == 200 and f["media_id"].startswith("team:") and f["body"] == "labels", "file shared", r.text[:200])
        m = c.get(f"/api/inbox/media/{f['id']}", headers=H(tok))
        check(m.status_code == 200 and m.content == b"%PDF-1.4 test", "file opens from the app")
        big = c.post(f"/api/team/Shop A/{GROUP}/file", headers=H(tok), files={"file": ("big.bin", b"0" * (10 * 1024 * 1024 + 1), "application/octet-stream")})
        check(big.status_code == 413, "files over 10 MB refused")
        check(c.post("/api/team/Shop A/919000000083/post", headers=H(tok), json={"text": "x"}).status_code == 400, "only in group chats")
        convs = {x["customer_phone"]: x for x in c.get("/api/inbox/conversations", headers=H(tok)).json()}
        check(convs[GROUP]["team_unread"] == 0, "no unread badge for your own posts")

        print("An employee and the Team chat permission")
        temp = c.post("/api/employee/temporary-password", headers=H(tok)).json()["password"]
        first = c.post("/api/auth/login", json={"email": "emp101@gmail.com", "password": temp}).json()
        emp = c.post("/api/account/password", headers=H(first["token"]), json={"current_password": "", "new_password": "employee-test-pass-481"}).json()["token"]
        c.patch("/api/employee", headers=H(tok), json={"key": "team", "enabled": False})
        check(c.post(f"/api/team/Shop A/{GROUP}/post", headers=H(emp), json={"text": "hi"}).status_code == 403, "without the permission: can't post")
        convs = {x["customer_phone"]: x for x in c.get("/api/inbox/conversations", headers=H(emp)).json()}
        check(convs[GROUP]["team_unread"] == 2, "employee sees 2 new team messages", convs[GROUP])
        check(c.get("/api/inbox/unread", headers=H(emp)).json()["team_unread"] == 2, "counted in the sidebar badge")
        c.get(f"/api/inbox/conversations/Shop A/{GROUP}", headers=H(emp))
        check(c.get("/api/inbox/unread", headers=H(emp)).json()["team_unread"] == 0, "opening the group clears it (for that person)")
        c.patch("/api/employee", headers=H(tok), json={"key": "team", "enabled": True})
        r = c.post(f"/api/team/Shop A/{GROUP}/post", headers=H(emp), json={"text": "Done packing"})
        check(r.status_code == 200 and r.json()["messages"][-1]["sender"] == "emp101", "with the permission: posts under their name", r.text[:200])
        check(c.get("/api/inbox/unread", headers=H(tok)).json()["team_unread"] == 1, "owner gets a badge for the employee's post")

        print("Export")
        txt = c.get(f"/api/inbox/conversations/Shop A/{GROUP}/export", headers=H(tok)).text
        check("+919000000081: My order" in txt and "Team Member: Packed" in txt, "export names who wrote each message", txt)
        check("Owner (team): Packing list for today" in txt and "emp101 (team): Done packing" in txt, "team posts named in the export")

    print(f"\nALL {passed} CHECKS PASSED")
finally:
    asyncio.run(sql(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE'))
    print(f"(dropped test schema {SCHEMA})")
