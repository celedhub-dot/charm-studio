"""End-to-end check of WhatsApp message templates (order confirmations after the 24-hour window).

Runs the real app against a throwaway Postgres schema ("charm_test_templates") in the database from
backend/.env, with the template list and WhatsApp sends faked (nothing reaches Meta or 360dialog).

    cd backend
    .venv/Scripts/python.exe tests/test_templates.py
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

SCHEMA = "charm_test_templates"
os.environ.update(
    {
        "DB_SCHEMA": SCHEMA,
        "AUTH_SECRET": secrets.token_urlsafe(48),
        "ADMIN_PASSWORD": "legacy-pass-123",
        "RESET_PASSWORD": "",
        "WA_NUMBERS": "",
        "ANTHROPIC_API_KEY": "",
        "AI_PROVIDER": "anthropic",
        "READ_DEBOUNCE_SECONDS": "30",
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

sent, fetches = [], []
fail_next_send = []

RAW_TEMPLATES = [
    {  # positional, text header, footer, quick reply: sendable
        "name": "order_confirmation", "language": "en", "status": "approved", "category": "utility",
        "components": [
            {"type": "HEADER", "format": "TEXT", "text": "Order {{1}}"},
            {"type": "BODY", "text": "Hi {{1}}, your order {{2}} with the name \"{{3}}\" and {{4}} charm is confirmed."},
            {"type": "FOOTER", "text": "Celed Hub"},
            {"type": "BUTTONS", "buttons": [{"type": "QUICK_REPLY", "text": "Thanks"}]},
        ],
    },
    {  # named parameters: sendable
        "name": "shipped", "language": "en_US", "status": "APPROVED", "category": "UTILITY", "parameter_format": "NAMED",
        "components": [{"type": "BODY", "text": "Hi {{customer}}, order {{order_id}} has shipped."}],
    },
    {"name": "order_update", "language": "en", "status": "APPROVED", "category": "UTILITY",
     "components": [{"type": "BODY", "text": "Hi {{1}}, update on your order {{2}}: {{3}}"}]},
    {"name": "promo", "language": "en", "status": "PENDING", "category": "MARKETING",
     "components": [{"type": "BODY", "text": "Big sale!"}]},
    {"name": "with_image", "language": "en", "status": "APPROVED", "category": "MARKETING",
     "components": [{"type": "HEADER", "format": "IMAGE"}, {"type": "BODY", "text": "New charms"}]},
    {"name": "track", "language": "en", "status": "APPROVED", "category": "UTILITY",
     "components": [{"type": "BODY", "text": "Track it"},
                    {"type": "BUTTONS", "buttons": [{"type": "URL", "text": "Track", "url": "https://x.test/{{1}}"}]}]},
]


async def fake_fetch_templates(cfg):
    fetches.append(cfg["label"])
    if cfg.get("provider") != "360dialog" and not cfg.get("waba_id"):
        raise server.HTTPException(400, "To use templates with a Meta number, add its WhatsApp Business Account ID")
    return RAW_TEMPLATES


class FakeResp:
    def __init__(self, status=200, data=None):
        self.status_code, self._data, self.text = status, data or {}, str(data)

    def json(self):
        return self._data


async def fake_wa_post(cfg, path, payload):
    sent.append({"provider": cfg["provider"], "path": path, "payload": payload})
    if fail_next_send:
        fail_next_send.pop()
        return FakeResp(400, {"error": {"message": "(#132001) Template name does not exist in the translation"}})
    return FakeResp(200, {"messages": [{"id": f"wamid.T{len(sent)}"}]})


async def fake_set_webhook(api_key, url):
    return None


server.fetch_templates = fake_fetch_templates
server.wa_post = fake_wa_post
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

        print("Numbers")
        r = c.post("/api/wa/numbers", headers=H(tok), json={"label": "Shop", "provider": "360dialog", "phone_id": "918339039324", "token": "d360-test-key-0123456789ABCD"})
        check(r.status_code == 201, "add 360dialog number", r.text)
        r = c.post("/api/wa/numbers", headers=H(tok), json={"label": "Meta", "phone_id": "1234567890", "token": "EAAtest-token-0123456789", "skip_check": True, "waba_id": "12a"})
        check(r.status_code == 400 and "digits" in r.json()["detail"], "bad WABA ID refused")
        r = c.post("/api/wa/numbers", headers=H(tok), json={"label": "Meta", "phone_id": "1234567890", "token": "EAAtest-token-0123456789", "skip_check": True})
        meta = r.json()
        check(r.status_code == 201 and meta["waba_id"] == "", "Meta number added without WABA ID")
        r = c.get("/api/inbox/templates", headers=H(tok), params={"number": "Meta"})
        check(r.status_code == 400 and "Business Account ID" in r.json()["detail"], "Meta number asks for its WABA ID before templates")
        r = c.patch(f"/api/wa/numbers/{meta['id']}", headers=H(tok), json={"waba_id": " 1658055335961404 "})
        check(r.json()["waba_id"] == "1658055335961404", "WABA ID saved on edit")
        check(c.get("/api/inbox/templates", headers=H(tok), params={"number": "Meta"}).status_code == 200, "Meta templates load once the WABA ID is set")
        check(c.get("/api/inbox/templates", headers=H(tok), params={"number": "Nope"}).status_code == 400, "unknown number refused")

        print("Template list")
        fetches.clear()
        data = c.get("/api/inbox/templates", headers=H(tok), params={"number": "Shop"}).json()
        tpls = {t["name"]: t for t in data["templates"]}
        check([t["name"] for t in data["templates"][:3]] == ["order_confirmation", "order_update", "shipped"], "sendable templates listed first")
        oc = tpls["order_confirmation"]
        check(oc["sendable"] and oc["status"] == "APPROVED" and oc["header_params"] == ["1"] and oc["body_params"] == ["1", "2", "3", "4"], "positional blanks found", str(oc))
        check(oc["footer"] == "Celed Hub" and oc["buttons"] == ["Thanks"] and not oc["named"], "footer and buttons kept")
        check(tpls["shipped"]["named"] and tpls["shipped"]["body_params"] == ["customer", "order_id"], "named blanks found")
        check(not tpls["promo"]["sendable"] and "approved" in tpls["promo"]["problem"], "unapproved template not sendable")
        check(not tpls["with_image"]["sendable"] and "image header" in tpls["with_image"]["problem"], "image header not sendable")
        check(not tpls["track"]["sendable"] and "link button" in tpls["track"]["problem"], "link button with a variable not sendable")
        c.get("/api/inbox/templates", headers=H(tok), params={"number": "Shop"})
        check(len(fetches) == 1, "template list cached")
        c.get("/api/inbox/templates", headers=H(tok), params={"number": "Shop", "refresh": "true"})
        check(len(fetches) == 2, "refresh reloads from WhatsApp")

        print("Sending")
        # a customer who messaged 30 hours ago: typed replies are refused, templates are allowed
        old = int(time.time()) - 30 * 3600
        hook = c.get("/api/wa/numbers", headers=H(tok)).json()[0]["webhook_url"].replace("https://api.example.test", "")
        c.post(hook, json={"messages": [{"id": "wamid.OLD", "from": "919876543210", "type": "text", "timestamp": str(old), "text": {"body": "hi"}}],
                           "contacts": [{"wa_id": "919876543210", "profile": {"name": "Riya"}}]})
        check(c.post("/api/inbox/send", headers=H(tok), json={"number_label": "Shop", "to": "919876543210", "text": "Hi"}).status_code == 409, "typed reply refused after 24 hours")
        order = c.post("/api/orders", headers=H(tok), json={"order_id": "123456789012_1", "product_name": "AARAV", "charm": "Heart", "customer_phone": "919876543210", "channel": "Shop"}).json()
        check(order["confirmed_at"] is None, "new order not confirmed yet")

        base = {"number_label": "Shop", "to": "+91 98765 43210", "name": "order_confirmation", "language": "en"}
        r = c.post("/api/inbox/send-template", headers=H(tok), json={**base, "header_params": ["123456789012_1"], "body_params": ["Riya", "123456789012_1", "AARAV", ""]})
        check(r.status_code == 400 and "{{4}}" in r.json()["detail"], "empty blank refused", r.text)
        r = c.post("/api/inbox/send-template", headers=H(tok), json={**base, "body_params": ["Riya"]})
        check(r.status_code == 400 and "changed" in r.json()["detail"], "wrong number of blanks refused")
        r = c.post("/api/inbox/send-template", headers=H(tok), json={**base, "name": "promo"})
        check(r.status_code == 400 and "approved" in r.json()["detail"], "unapproved template refused")
        r = c.post("/api/inbox/send-template", headers=H(tok), json={**base, "name": "missing"})
        check(r.status_code == 404, "unknown template refused")
        check(not sent, "nothing sent for refused requests")

        r = c.post("/api/inbox/send-template", headers=H(tok), json={
            **base, "header_params": ["123456789012_1"], "body_params": ["Riya", "123456789012_1", "AARAV\n  big", "Heart"], "order_id": order["id"]})
        check(r.status_code == 200, "template sent outside the 24-hour window", r.text)
        p = sent[-1]["payload"]
        check(p["type"] == "template" and p["to"] == "919876543210" and p["template"]["name"] == "order_confirmation" and p["template"]["language"] == {"code": "en"}, "template payload")
        comps = p["template"]["components"]
        check(comps[0] == {"type": "header", "parameters": [{"type": "text", "text": "123456789012_1"}]}, "header variable sent")
        check([x["text"] for x in comps[1]["parameters"]] == ["Riya", "123456789012_1", "AARAV big", "Heart"], "body variables sent, new lines removed")
        out = [m for m in r.json()["messages"] if m["direction"] == "out"][-1]
        check(out["kind"] == "template" and out["source"] == "staff" and out["status"] == "sent", "stored in the chat as a staff template")
        check(out["body"].startswith("Order 123456789012_1\n\nHi Riya, your order 123456789012_1 with the name \"AARAV big\" and Heart charm is confirmed.") and out["body"].endswith("Celed Hub"), "chat shows the filled-in text", out["body"])
        check(r.json()["order"]["confirmed_at"], "order marked as confirmed")
        check(c.get("/api/orders?q=123456789012", headers=H(tok)).json()[0]["confirmed_at"], "confirmation shows in the orders list")
        check(not r.json()["contact"]["window_open"], "a template doesn't reopen the reply window")

        r = c.post("/api/inbox/send-template", headers=H(tok), json={"number_label": "Shop", "to": "917000011111", "name": "shipped", "language": "en_US", "body_params": ["Kabir", "OD1"]})
        check(r.status_code == 200, "template can start a brand-new chat", r.text)
        check(sent[-1]["payload"]["template"]["components"][0]["parameters"] == [
            {"type": "text", "text": "Kabir", "parameter_name": "customer"}, {"type": "text", "text": "OD1", "parameter_name": "order_id"}], "named variables sent with their names")
        check(any(cv["customer_phone"] == "917000011111" for cv in c.get("/api/inbox/conversations", headers=H(tok)).json()), "new chat listed")

        fail_next_send.append(1)
        r = c.post("/api/inbox/send-template", headers=H(tok), json={"number_label": "Shop", "to": "917000011111", "name": "shipped", "language": "en_US", "body_params": ["Kabir", "OD2"]})
        check(r.status_code == 502 and "132001" in r.json()["detail"], "WhatsApp's error is shown")
        msgs = c.get("/api/inbox/conversations/Shop/917000011111", headers=H(tok)).json()["messages"]
        check(msgs[-1]["status"] == "failed" and "132001" in msgs[-1]["error"], "failed template stored as failed")

        print("Remembered settings")
        r = c.put("/api/settings/templates", headers=H(tok), json={
            "confirmation": {"name": "order_confirmation", "language": "en"},
            "maps": {"order_confirmation|en": {"header": ["{order_id}"], "body": ["{customer_name}", "{order_id}", "{product_name}", "{charm}"]}}})
        check(r.status_code == 200 and r.json()["templates"]["confirmation"]["name"] == "order_confirmation", "confirmation template saved", r.text)
        s = c.get("/api/inbox/templates", headers=H(tok), params={"number": "Shop"}).json()["settings"]
        check(s["maps"]["order_confirmation|en"]["body"][2] == "{product_name}", "field mapping returned with the templates")
        check(c.get("/api/settings", headers=H(tok)).json()["templates"]["maps"], "settings endpoint includes templates")

        print("Late replies (after the 24-hour window)")
        late_text = {"number_label": "Shop", "to": "919876543210", "text": "Your charm is ready.\nShipping today!"}
        th = c.get("/api/inbox/conversations/Shop/919876543210", headers=H(tok)).json()
        check(th["number"]["late_reply"] == "" and not th["contact"]["window_open"], "no late-reply template yet, window closed")
        check(c.post("/api/inbox/send", headers=H(tok), json=late_text).status_code == 409, "typed reply still refused without a late-reply template")
        maps = {"order_confirmation|en": {"header": ["{order_id}"], "body": ["{customer_name}", "{order_id}", "{product_name}", "{charm}"]},
                "order_update|en": {"header": [], "body": ["{customer_name}", "{order_id}", "{customer_name}"]}}
        c.put("/api/settings/templates", headers=H(tok), json={"confirmation": {"name": "order_confirmation", "language": "en"},
                                                                "late_reply": {"name": "order_update", "language": "en"}, "maps": maps})
        check(c.get("/api/inbox/conversations/Shop/919876543210", headers=H(tok)).json()["number"]["late_reply"] == "",
              "late-reply template ignored until one blank holds the message")
        maps["order_update|en"]["body"][2] = "{message}"
        r = c.put("/api/settings/templates", headers=H(tok), json={"confirmation": {"name": "order_confirmation", "language": "en"},
                                                                    "late_reply": {"name": "order_update", "language": "en"}, "maps": maps})
        check(r.json()["templates"]["late_reply"]["name"] == "order_update", "late-reply template saved")
        check(c.get("/api/inbox/conversations/Shop/919876543210", headers=H(tok)).json()["number"]["late_reply"] == "order_update", "chat knows late replies are on")
        before = len(sent)
        r = c.post("/api/inbox/send", headers=H(tok), json=late_text)
        check(r.status_code == 200 and r.json().get("sent_as_template") == "order_update", "typed reply sent after 24 hours", r.text)
        p = sent[-1]["payload"]
        check(len(sent) == before + 1 and p["type"] == "template" and p["template"]["name"] == "order_update", "went out as the template")
        check([x["text"] for x in p["template"]["components"][0]["parameters"]] == ["Riya", "123456789012_1", "Your charm is ready. Shipping today!"],
              "name and order ID filled in, message in its blank (new line removed)", str(p))
        out = [m for m in r.json()["messages"] if m["direction"] == "out"][-1]
        check(out["kind"] == "template" and out["body"] == "Hi Riya, update on your order 123456789012_1: Your charm is ready. Shipping today!", "chat shows the full text")
        r = c.post("/api/inbox/send", headers=H(tok), json={**late_text, "to": "917000011111"})
        check(r.status_code == 409 and "order ID" in r.json()["detail"], "customer with no order ID gets a clear message", r.text)
        c.post(hook, json={"messages": [{"id": "wamid.NEW", "from": "919876543210", "type": "text", "timestamp": str(int(time.time())), "text": {"body": "ok thanks"}}]})
        r = c.post("/api/inbox/send", headers=H(tok), json={**late_text, "text": "You're welcome!"})
        check(r.status_code == 200 and sent[-1]["payload"]["type"] == "text" and not r.json().get("sent_as_template"), "open window: normal free reply again")
        check(c.post("/api/inbox/send-template", json=base).status_code == 401, "sending needs login")

    print(f"\nALL {passed} CHECKS PASSED")
finally:
    asyncio.run(drop_schema())
    print(f"(dropped test schema {SCHEMA})")
