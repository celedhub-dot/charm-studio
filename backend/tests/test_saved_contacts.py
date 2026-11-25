"""Saved contacts: the bot never replies to them or reads their chats, on any number; phone-contact import.

Runs the real app against a throwaway Postgres schema ("charm_test_saved"); WhatsApp and the AI are faked.

    cd backend
    .venv/Scripts/python.exe tests/test_saved_contacts.py
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

SCHEMA = "charm_test_saved"
os.environ.update({"DB_SCHEMA": SCHEMA, "AUTH_SECRET": secrets.token_urlsafe(48), "ADMIN_PASSWORD": "legacy-pass-123",
                   "RESET_PASSWORD": "", "WA_NUMBERS": "", "ANTHROPIC_API_KEY": "", "AI_PROVIDER": "anthropic",
                   "BOT_REPLY_WAIT_SECONDS": "2", "READ_DEBOUNCE_SECONDS": "1", "PUBLIC_BASE_URL": "https://api.example.test"})


async def drop_schema():
    conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
    await conn.execute(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE')
    await conn.close()


asyncio.run(drop_schema())

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


def msg(c, hook, mid, frm, body):
    value = {"contacts": [{"wa_id": frm, "profile": {"name": "Someone"}}],
             "messages": [{"id": mid, "from": frm, "type": "text", "timestamp": str(int(time.time())), "text": {"body": body}}]}
    assert c.post(hook, json={"object": "whatsapp_business_account", "entry": [{"changes": [{"field": "messages", "value": value}]}]}).status_code == 200


def to(phone):
    return [t for p, t in sent if p == phone]


VCF = """BEGIN:VCARD
VERSION:3.0
FN:Team Member One
TEL;TYPE=CELL:+91 90000 00071
END:VCARD
BEGIN:VCARD
VERSION:2.1
FN:Family Member
TEL;CELL:090000-00072
TEL;HOME:0512 2345678
END:VCARD
"""
CSV = "Name,Phone 1 - Type,Phone 1 - Value\nSupplier Raj,Mobile,+91 90000 11111 ::: 90000 22222\nNo Number,,\n"

try:
    print("Phone numbers and contact files")
    n = server.normalize_contact_phone
    check(n("90000 00072") == n("+91 90000-00072") == n("090000 00072") == n("0091 9000000072") == "919000000072", "Indian numbers in any format")
    check(n("12") == "", "too short is rejected")
    vcf = server.parse_contacts_file(VCF)
    check(("919000000071", "Team Member One") in vcf and ("919000000072", "Family Member") in vcf, "vCard names and mobile numbers", vcf)
    csvp = server.parse_contacts_file(CSV)
    check({p for p, _ in csvp} == {"919000011111", "919000022222"} and csvp[0][1] == "Supplier Raj", "Google Contacts CSV, several numbers in one cell", csvp)

    with TestClient(server.app) as c:
        tok = c.post("/api/auth/login", json={"password": "legacy-pass-123"}).json()["token"]
        tok = c.post("/api/account/setup", headers=H(tok), json={"name": "Owner", "email": "o@x.test", "password": "mango-river-42"}).json()["token"]
        a = c.post("/api/wa/numbers", headers=H(tok), json={"label": "Shop A", "provider": "360dialog", "phone_id": "918339039324", "token": "d360-test-key-0123456789ABCD"}).json()
        b = c.post("/api/wa/numbers", headers=H(tok), json={"label": "Shop B", "provider": "360dialog", "phone_id": "918339039325", "token": "d360-test-key-0123456789ABCE"}).json()
        for n_ in (a, b):
            c.patch(f"/api/wa/numbers/{n_['id']}", headers=H(tok), json={"bot_mode": "ask"})
        hook_a = a["webhook_url"].replace("https://api.example.test", "")
        hook_b = b["webhook_url"].replace("https://api.example.test", "")

        print("Import and manage")
        r = c.post("/api/saved-contacts/import", headers=H(tok), files={"file": ("contacts.vcf", VCF.encode(), "text/vcard")}).json()
        check(r["added"] >= 2, "contacts file imported", r)
        r = c.post("/api/saved-contacts/import", headers=H(tok), files={"file": ("contacts.vcf", VCF.encode(), "text/vcard")}).json()
        check(r["added"] == 0 and r["already_saved"] == r["numbers_in_file"], "importing again adds nothing", r)
        check(c.post("/api/saved-contacts", headers=H(tok), json={"phone": "not-a-number", "name": "x"}).status_code == 400, "bad number refused")
        check(c.get("/api/saved-contacts").status_code == 401, "list needs login")

        print("A saved contact writes to two numbers")
        sent.clear(); ai_calls.clear()
        msg(c, hook_a, "s1", "919000000071", "Hi bhai, 3 home key ready?")
        msg(c, hook_b, "s2", "919000000071", "ok")
        time.sleep(server.BOT_WAIT_S + 4)
        check(not to("919000000071"), "no bot reply on either number")
        check(not ai_calls, "no AI call at all")
        convs = c.get("/api/inbox/conversations", headers=H(tok)).json()
        mine = [x for x in convs if x["customer_phone"] == "919000000071"]
        check(len(mine) == 2 and all(x["saved_contact"] for x in mine), "messages still in Chats on both numbers, marked saved", mine)
        th = c.get("/api/inbox/conversations/Shop A/919000000071", headers=H(tok)).json()
        check(th["contact"]["saved_contact"] and len(th["messages"]) == 1, "thread shows the saved mark")
        rr = c.post("/api/inbox/conversations/Shop A/919000000071/read-orders", headers=H(tok)).json()
        check(rr.get("saved_contact") and not rr["orders"] and not ai_calls, "Read chat refuses, no AI call", rr)

        print("A customer still gets the bot")
        msg(c, hook_a, "c1", "919111222333", "Hi, my order is 123456789012_1")
        end = time.time() + 30
        while time.time() < end and not to("919111222333"):
            time.sleep(0.5)
        check(to("919111222333"), "customer gets a reply", sent)

        print("Mark and unmark from the chat menu")
        x = c.patch("/api/inbox/conversations/Shop A/919111222333", headers=H(tok), json={"saved": True}).json()
        check(x["saved_contact"], "marked as saved from the chat")
        before = len(to("919111222333"))
        msg(c, hook_a, "c2", "919111222333", "name AARAV")
        time.sleep(server.BOT_WAIT_S + 4)
        check(len(to("919111222333")) == before, "now silent")
        x = c.patch("/api/inbox/conversations/Shop A/919111222333", headers=H(tok), json={"saved": False}).json()
        check(not x["saved_contact"], "unmarked")
        check(c.delete("/api/saved-contacts/919000000072", headers=H(tok)).status_code == 200, "removed from Settings")
        check("919000000072" not in [s["phone"] for s in c.get("/api/saved-contacts", headers=H(tok)).json()], "gone from the list")

    print(f"\nALL {passed} CHECKS PASSED")
finally:
    asyncio.run(drop_schema())
    print(f"(dropped test schema {SCHEMA})")
