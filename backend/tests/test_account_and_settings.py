"""End-to-end check of accounts, password reset, WhatsApp numbers and settings.

Runs the real app against a throwaway Postgres schema ("charm_test") in the database
from backend/.env, with Meta and Resend calls faked. Your real tables are not touched.

    cd backend
    .venv/Scripts/python.exe tests/test_account_and_settings.py
"""
import asyncio
import json
import os
import secrets
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
load_dotenv(BACKEND / ".env")

SCHEMA = "charm_test_" + secrets.token_hex(6)
WA_TOKEN = "EAAtesttoken1234567890abcdWXYZ"
os.environ.update(
    {
        "DB_SCHEMA": SCHEMA,
        "AUTH_SECRET": secrets.token_urlsafe(48),
        "ADMIN_PASSWORD": "legacy-pass-123",
        "BOT_REPLY_WAIT_SECONDS": "0",
        "BOT_FEWER_FOLLOWUPS": "false",
        "ANTHROPIC_API_KEY": "",
        "OLLAMA_API_KEY": "",
        "RESET_PASSWORD": "",
        "RESEND_API_KEY": "re_test_fake",
        "FRONTEND_URL": "http://localhost:3000",
        "WA_NUMBERS": "main",
        "WA_MAIN_PHONE_ID": "1234567890",
        "WA_MAIN_TOKEN": WA_TOKEN,
        "WA_MAIN_DISPLAY": "+91 90000 00000",
        "WA_MAIN_VERIFY": "per-number-verify",
    }
)


async def drop_schema():
    conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
    await conn.execute(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE')
    await conn.close()


asyncio.run(drop_schema())

import server  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

sent_emails, meta_calls, wa_sent = [], [], []
meta_should_fail = {"value": False}


async def fake_send_reset_email(to, name, link):
    sent_emails.append({"to": to, "name": name, "link": link})
    return True


async def fake_meta_check(phone_id, token):
    meta_calls.append((phone_id, token))
    if meta_should_fail["value"]:
        raise HTTPException(server.META_CHECK_FAILED, "Meta rejected these details: test")
    return {"display_phone_number": "+91 98765 43210", "verified_name": "Test Shop", "quality_rating": "GREEN"}


class FakeResp:
    status_code = 200


async def fake_send_wa(cfg, to, text):
    wa_sent.append({"label": cfg["label"], "to": to, "text": text})
    return FakeResp()


server.send_reset_email = fake_send_reset_email
server.meta_check = fake_meta_check
server.send_wa = fake_send_wa
server.ORDER_ID_GUIDE = BACKEND / "unavailable-guide-for-account-test"

passed = 0


def check(cond, label, extra=""):
    global passed
    if not cond:
        raise AssertionError(f"FAILED: {label} {extra}")
    passed += 1
    print(f"  ok  {label}")


def H(token):
    return {"Authorization": f"Bearer {token}"}


try:
    with TestClient(server.app) as c:
        print("First login and setup")
        cfg = c.get("/api/auth/config").json()
        check(cfg["setup_required"] is True and cfg["problem"] is None, "config says setup required")
        check(c.get("/api/orders").status_code == 401, "orders need a token")
        check(c.post("/api/auth/login", json={"password": "nope-nope-1"}).status_code == 401, "wrong first password refused")
        r = c.post("/api/auth/login", json={"password": "legacy-pass-123"}).json()
        setup_token = r["token"]
        check(r["scope"] == "setup", "ADMIN_PASSWORD gives a setup-only token")
        check(c.get("/api/orders", headers=H(setup_token)).status_code == 403, "setup token can't use the app")
        check(c.get("/api/auth/me", headers=H(setup_token)).json()["scope"] == "setup", "me shows setup scope")
        r = c.post("/api/account/setup", headers=H(setup_token), json={"name": "Priya", "email": "Priya@Example.com", "password": "12345678"})
        check(r.status_code == 400 and "easy to guess" in r.json()["detail"], "common password rejected")
        r = c.post("/api/account/setup", headers=H(setup_token), json={"name": "Priya", "email": "not-an-email", "password": "mango-river-42"})
        check(r.status_code == 400, "bad email rejected")
        r = c.post("/api/account/setup", headers=H(setup_token), json={"name": "  Priya   S ", "email": "Priya@Example.com", "password": "mango-river-42"})
        check(r.status_code == 200 and r.json()["scope"] == "full", "setup completes with a full token")
        tok = r.json()["token"]
        employee = "emp101@gmail.com"
        access = c.get("/api/employee", headers=H(tok)).json()
        assert access["username"] == employee and len(access["permissions"]) == 14
        temporary = c.post("/api/employee/temporary-password", headers=H(tok)).json()["password"]
        first = c.post("/api/auth/login", json={"email": employee, "password": temporary}).json()
        assert first["scope"] == "password"
        assert c.get("/api/orders", headers=H(first["token"])).status_code == 403
        employee_token = c.post("/api/account/password", headers=H(first["token"]),
                                json={"current_password": "", "new_password": "employee-test-pass-481"}).json()["token"]
        assert c.get("/api/orders", headers=H(employee_token)).status_code == 200
        assert c.get("/api/employee", headers=H(employee_token)).status_code == 403
        assert c.get("/api/account", headers=H(employee_token)).status_code == 403
        for key in ("orders", "ai_labels"):
            assert c.patch("/api/employee", headers=H(tok), json={"key": key, "enabled": False}).status_code == 200
        assert c.get("/api/orders", headers=H(employee_token)).status_code == 403
        assert c.post("/api/pdf/analyze", headers=H(employee_token), data={"model": "paid"},
                      files={"file": ("test.pdf", b"test")}).status_code == 403
        assert c.patch("/api/employee", headers=H(tok), json={"key": "enabled", "enabled": False}).status_code == 200
        assert c.get("/api/auth/me", headers=H(employee_token)).status_code == 401
        assert c.post("/api/auth/forgot", json={"email": employee}).status_code == 200 and not sent_emails
        print("Employee first login, revocation, owner isolation, AI permissions and disabling passed.")
        check(c.get("/api/auth/me", headers=H(setup_token)).status_code == 401, "old setup token stops working")
        me = c.get("/api/auth/me", headers=H(tok)).json()
        check(me["name"] == "Priya S" and me["email"] == "priya@example.com", "name trimmed, email lowercased")
        cfg = c.get("/api/auth/config").json()
        check(cfg["setup_required"] is False and cfg["password_reset_email"] is True, "config after setup")

        print("Login")
        check(c.post("/api/auth/login", json={"email": "other@example.com", "password": "mango-river-42"}).status_code == 401, "wrong email refused")
        check(c.post("/api/auth/login", json={"email": "priya@example.com", "password": "legacy-pass-123"}).status_code == 401, "ADMIN_PASSWORD no longer works")
        r = c.post("/api/auth/login", json={"email": " PRIYA@example.com ", "password": "mango-river-42"})
        check(r.status_code == 200 and r.json()["scope"] == "full", "email+password login (email case-insensitive)")
        tok2 = r.json()["token"]
        server._login_failures.clear()

        print("Change password")
        r = c.post("/api/account/password", headers=H(tok2), json={"current_password": "wrong", "new_password": "tulip-anchor-58"})
        check(r.status_code == 400, "wrong current password refused")
        r = c.post("/api/account/password", headers=H(tok2), json={"current_password": "mango-river-42", "new_password": "mango-river-42"})
        check(r.status_code == 400, "same password refused")
        r = c.post("/api/account/password", headers=H(tok2), json={"current_password": "mango-river-42", "new_password": "tulip-anchor-58"})
        check(r.status_code == 200, "password changed")
        tok3 = r.json()["token"]
        check(c.get("/api/account", headers=H(tok2)).status_code == 401, "other sessions logged out after password change")
        check(c.get("/api/account", headers=H(tok3)).status_code == 200, "this device stays logged in")

        print("Profile and session")
        r = c.put("/api/account/profile", headers=H(tok3), json={"name": "Priya Sharma", "email": "new@example.com"})
        check(r.status_code == 400, "email change needs current password")
        r = c.put("/api/account/profile", headers=H(tok3), json={"name": "Priya Sharma", "email": "new@example.com", "current_password": "tulip-anchor-58"})
        check(r.status_code == 200 and r.json()["email"] == "new@example.com", "email changed with password")
        r = c.put("/api/account/profile", headers=H(tok3), json={"name": "Priya Sharma", "email": "new@example.com"})
        check(r.status_code == 200, "name-only change needs no password")
        check(c.put("/api/account/session", headers=H(tok3), json={"session_days": 5}).status_code == 400, "odd session length refused")
        check(c.put("/api/account/session", headers=H(tok3), json={"session_days": 7}).json()["session_days"] == 7, "session length saved")
        r = c.post("/api/auth/login", json={"email": "new@example.com", "password": "tulip-anchor-58"})
        check(r.status_code == 200, "login with new email")
        other = r.json()["token"]
        r = c.post("/api/account/logout-others", headers=H(tok3))
        tok4 = r.json()["token"]
        check(c.get("/api/account", headers=H(other)).status_code == 401 and c.get("/api/account", headers=H(tok4)).status_code == 200, "log out other devices")
        logins = c.get("/api/account/logins", headers=H(tok4)).json()
        check(len(logins) >= 5 and {"first_login", "account_setup", "logout_all"} <= {e["method"] for e in logins}, "login history recorded")

        print("Password reset by email")
        r = c.post("/api/auth/forgot", json={"email": "someone@else.com"})
        check(r.status_code == 200 and not sent_emails, "unknown email: generic reply, no email")
        r = c.post("/api/auth/forgot", json={"email": "NEW@example.com"})
        check(r.status_code == 200 and len(sent_emails) == 1, "reset email sent to the account email")
        link = sent_emails[0]["link"]
        check(link.startswith("http://localhost:3000/reset-password?token="), "link points at the frontend")
        token = link.split("token=", 1)[1]
        check(c.post("/api/auth/reset", json={"token": token, "password": "11111111"}).status_code == 400, "weak reset password refused")
        check(c.post("/api/auth/reset", json={"token": "bogus", "password": "fresh-start-77"}).status_code == 400, "bogus reset token refused")
        check(c.post("/api/auth/reset", json={"token": token, "password": "fresh-start-77"}).status_code == 200, "password reset")
        check(c.post("/api/auth/reset", json={"token": token, "password": "another-one-88"}).status_code == 400, "reset link works only once")
        check(c.get("/api/account", headers=H(tok4)).status_code == 401, "reset logs out every device")
        r = c.post("/api/auth/login", json={"email": "new@example.com", "password": "fresh-start-77"})
        check(r.status_code == 200, "login with reset password")
        tok = r.json()["token"]
        server._login_failures.clear()

        print("Emergency RESET_PASSWORD")
        server.RESET_PASSWORD = "emergency-pass-9"
        r = c.post("/api/auth/login", json={"email": "new@example.com", "password": "emergency-pass-9"})
        check(r.status_code == 200 and r.json()["scope"] == "password", "override gives a change-password-only token")
        ptok = r.json()["token"]
        check(c.get("/api/orders", headers=H(ptok)).status_code == 403, "override token can't use the app")
        r = c.post("/api/account/password", headers=H(ptok), json={"new_password": "brand-new-pass-5"})
        check(r.status_code == 200 and r.json()["scope"] == "full", "new password chosen without the old one")
        server.RESET_PASSWORD = ""
        tok = r.json()["token"]
        check(c.post("/api/auth/login", json={"email": "new@example.com", "password": "brand-new-pass-5"}).status_code == 200, "new password works")

        print("WhatsApp numbers")
        nums = c.get("/api/wa/numbers", headers=H(tok)).json()
        check(len(nums) == 1 and nums[0]["label"] == "main" and nums[0]["token_ok"] and nums[0]["active"], "env number imported once")
        check(WA_TOKEN not in json.dumps(nums) and nums[0]["token_hint"].endswith("WXYZ"), "token never returned, only last 4")
        check(nums[0]["has_verify_token"], "per-number verify token imported")
        r = c.get("/api/wa/webhook", params={"hub.mode": "subscribe", "hub.verify_token": "per-number-verify", "hub.challenge": "42"})
        check(r.text == "42", "imported verify token accepted by webhook")
        main_id = nums[0]["id"]
        meta_should_fail["value"] = True
        body = {"label": "Store 2", "phone_id": "5550001111", "token": "EAAsecondtoken0000000000LAST"}
        r = c.post("/api/wa/numbers", headers=H(tok), json=body)
        check(r.status_code == 424, "Meta rejection reported as 424")
        r = c.post("/api/wa/numbers", headers=H(tok), json={**body, "skip_check": True})
        check(r.status_code == 201 and r.json()["display"] == "", "save anyway works")
        meta_should_fail["value"] = False
        s2 = r.json()["id"]
        check(c.post("/api/wa/numbers", headers=H(tok), json={**body, "label": "store 2", "phone_id": "999999"}).status_code == 409, "duplicate name refused")
        check(c.post("/api/wa/numbers", headers=H(tok), json={**body, "label": "Store 3"}).status_code == 409, "duplicate phone ID refused")
        check(c.post("/api/wa/numbers", headers=H(tok), json={**body, "label": "Store 3", "phone_id": "12ab"}).status_code == 400, "bad phone ID refused")
        r = c.post("/api/wa/numbers", headers=H(tok), json={"label": "Store 3", "phone_id": "7770002222", "token": "EAAthirdtoken111111111111ABCD"})
        check(r.status_code == 201 and r.json()["display"] == "+91 98765 43210", "Meta check fills display number")
        s3 = r.json()["id"]
        r = c.patch(f"/api/wa/numbers/{s2}", headers=H(tok), json={"active": False})
        check(r.status_code == 200 and r.json()["active"] is False, "pause number")
        check("5550001111" not in server.WA_NUMBERS and len(server.WA_ALL) == 3, "paused number ignored by bot")
        r = c.patch(f"/api/wa/numbers/{s2}", headers=H(tok), json={"active": True, "token": "EAAreplacedtoken99999999NEWT"})
        check(r.json()["token_hint"].endswith("NEWT") and meta_calls[-1][1] == "EAAreplacedtoken99999999NEWT", "resume + replace token (checked with Meta)")
        check(c.post(f"/api/wa/numbers/{s2}/check", headers=H(tok)).json()["display_phone_number"] == "+91 98765 43210", "check connection")
        check(next(n for n in c.get("/api/wa/numbers", headers=H(tok)).json() if n["id"] == s2)["display"] == "+91 98765 43210", "check fills missing display")

        print("Bot wording and shop name")
        shop = c.put("/api/settings/shop", headers=H(tok), json={"shop_name": "  Priya   Charms "}).json()
        check(shop["shop"]["shop_name"] == "Priya Charms", "shop name saved")
        bot = {
            "ask_order_id": "Namaste! Order ID bhejiye.",
            "ask_product_name": "Charm par kaunsa naam?",
            "ask_charm": "Kaunsa charm?",
            "ask_notes": "Koi note? 'none' likhein.",
            "thank_you": "Dhanyavaad from {shop_name}! {order_id} / {name} / {charm} / {notes} {unknown}",
        }
        check(c.put("/api/settings/bot", headers=H(tok), json={**bot, "ask_charm": ""}).status_code == 422, "empty bot message refused")
        check(c.put("/api/settings/bot", headers=H(tok), json=bot).status_code == 200, "bot wording saved")
        cfg_main = server.WA_NUMBERS["1234567890"]

        async def chat():
            await server.db().execute("DELETE FROM wa_conversations")
            for msg in ["hi", "1234567890123_1", "Aarav", "Heart", "none"]:
                await server.handle_bot_message(cfg_main, "919000000001", msg)

        c.portal.call(chat)
        texts = [m["text"] for m in wa_sent[-5:]]
        check(texts[0] == "Namaste! Order ID bhejiye." and texts[1] == "Charm par kaunsa naam?", "bot uses custom questions")
        check(texts[-1] == "Dhanyavaad from Priya Charms! 1234567890123_1 / Aarav / 46 (Red heart) / - {unknown}", "thank-you placeholders filled", texts[-1])

        print("Rename and delete")

        async def start_chat():
            await server.handle_bot_message(cfg_main, "919000000002", "hi")

        c.portal.call(start_chat)
        r = c.patch(f"/api/wa/numbers/{main_id}", headers=H(tok), json={"label": "Main shop"})
        check(r.json()["label"] == "Main shop", "rename number")
        convs = c.get("/api/wa/conversations", headers=H(tok)).json()
        check(any(cv["business_number_id"] == "Main shop" for cv in convs), "in-progress chat follows the rename")
        check(c.delete(f"/api/wa/numbers/{s3}", headers=H(tok)).status_code == 200 and len(server.WA_ALL) == 2, "delete number")
        stored = c.portal.call(lambda: server.db().fetch("SELECT token_enc, verify_token_enc FROM wa_numbers"))
        check(all(WA_TOKEN not in r["token_enc"] and r["token_enc"].startswith("v1:") for r in stored), "tokens encrypted at rest")

        print("Label defaults and status")
        check(c.put("/api/settings/labels", headers=H(tok), json={"position": "middle", "font_size": 8}).status_code == 422, "bad corner refused")
        check(c.put("/api/settings/labels", headers=H(tok), json={"position": "top-left", "font_size": 20}).status_code == 422, "font size limited")
        lab = c.put("/api/settings/labels", headers=H(tok), json={"position": "top-left", "font_size": 9.5, "skip_unmatched": True}).json()
        check(lab["labels"] == {"position": "top-left", "font_size": 9.5, "skip_unmatched": True}, "label defaults saved")
        st = c.get("/api/system/status", headers=H(tok)).json()
        check(st["email_reset"]["configured"] and st["whatsapp"]["saved"] == 2 and st["reset_override_active"] is False, "system status")

    print("Restart keeps everything")
    with TestClient(server.app) as c:
        r = c.post("/api/auth/login", json={"email": "new@example.com", "password": "brand-new-pass-5"})
        check(r.status_code == 200, "account survives restart")
        tok = r.json()["token"]
        nums = c.get("/api/wa/numbers", headers=H(tok)).json()
        check(len(nums) == 2 and all(n["token_ok"] for n in nums), "numbers (not re-imported) survive restart")
        check(c.get("/api/settings", headers=H(tok)).json()["shop"]["shop_name"] == "Priya Charms", "settings survive restart")

    print(f"\nALL {passed} CHECKS PASSED")
finally:
    asyncio.run(drop_schema())
    print(f"(dropped test schema {SCHEMA})")
