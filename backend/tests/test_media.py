"""End-to-end check of photos, voice notes and files in Chats.

Runs the real app against a throwaway Postgres schema ("charm_test_media") in the database from backend/.env.
WhatsApp is replaced by a fake HTTP transport, so the real download/upload code runs but nothing leaves the PC.

    cd backend
    .venv/Scripts/python.exe tests/test_media.py
"""
import asyncio
import json
import os
import secrets
import sys
import time
from pathlib import Path

import asyncpg
import httpx
from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
load_dotenv(BACKEND / ".env")

SCHEMA = "charm_test_media"
os.environ.update(
    {
        "DB_SCHEMA": SCHEMA,
        "AUTH_SECRET": secrets.token_urlsafe(48),
        "ADMIN_PASSWORD": "legacy-pass-123",
        "RESET_PASSWORD": "",
        "WA_NUMBERS": "",
        "ANTHROPIC_API_KEY": "",
        "AI_PROVIDER": "anthropic",
        "READ_DEBOUNCE_SECONDS": "0.3",
        "PUBLIC_BASE_URL": "https://api.example.test",
        "D360_BASE_URL": "https://waba-v2.360dialog.io",
    }
)


async def drop_schema():
    conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
    await conn.execute(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE')
    await conn.close()


asyncio.run(drop_schema())

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

PHOTO = b"\xff\xd8\xff\xe0fake-jpeg-bytes" * 50
VOICE = b"OggSfake-opus" * 40
calls = []  # (method, url, headers, body)
uploads = {}


def fake_whatsapp(request: httpx.Request) -> httpx.Response:
    url = str(request.url)
    calls.append((request.method, url, dict(request.headers), request.content))
    host = request.url.host
    path = request.url.path
    if host == "waba-v2.360dialog.io":
        assert request.headers.get("d360-api-key") == "d360-test-key-0123456789ABCD", "360dialog key missing"
        if request.method == "POST" and path == "/v1/configs/webhook":
            return httpx.Response(200, json={})
        if request.method == "POST" and path == "/messages":
            return httpx.Response(200, json={"messages": [{"id": f"wamid.OUT{len(calls)}"}]})
        if request.method == "POST" and path == "/media":
            new_id = f"up{len(uploads) + 1}"
            uploads[new_id] = request.content
            return httpx.Response(200, json={"id": new_id})
        if path == "/media-photo-1":
            return httpx.Response(200, json={"url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=photo1", "mime_type": "image/jpeg", "file_size": len(PHOTO)})
        if path == "/media-voice-1":
            return httpx.Response(200, json={"url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=voice1", "mime_type": "audio/ogg; codecs=opus", "file_size": len(VOICE)})
        if path == "/media-gone":
            return httpx.Response(404, json={"error": {"message": "media not found"}})
        if path == "/whatsapp_business/attachments/":
            mid = request.url.params.get("mid")
            return httpx.Response(200, content=PHOTO if mid == "photo1" else VOICE, headers={"content-type": "application/octet-stream"})
    if host == "graph.facebook.com":
        assert request.headers.get("authorization") == "Bearer EAAtest-token-0123456789", "Meta token missing"
        if path.endswith("/meta-photo"):
            return httpx.Response(200, json={"url": "https://lookaside.fbsbx.com/meta?mid=mp", "mime_type": "image/png"})
    if host == "lookaside.fbsbx.com":
        assert request.headers.get("authorization") == "Bearer EAAtest-token-0123456789"
        return httpx.Response(200, content=b"\x89PNGmeta", headers={"content-type": "image/png"})
    return httpx.Response(500, json={"error": {"message": f"unexpected {request.method} {url}"}})


class FakeAsyncClient(httpx.AsyncClient):
    def __init__(self, *a, **kw):
        kw["transport"] = httpx.MockTransport(fake_whatsapp)
        super().__init__(*a, **kw)


server.httpx.AsyncClient = FakeAsyncClient

passed = 0


def check(cond, label, extra=""):
    global passed
    if not cond:
        raise AssertionError(f"FAILED: {label} {extra}")
    passed += 1
    print(f"  ok  {label}")


def H(t):
    return {"Authorization": f"Bearer {t}"}


def payload(messages=None, echoes=None):
    value = {"messaging_product": "whatsapp", "metadata": {"phone_number_id": "1234567890"},
             "contacts": [{"wa_id": "919876543210", "profile": {"name": "Riya"}}]}
    if messages:
        value["messages"] = messages
    if echoes:
        value["message_echoes"] = echoes
    return {"object": "whatsapp_business_account", "entry": [{"changes": [{"field": "messages", "value": value}]}]}


def wait_for(fn, label, timeout=8.0):
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return
        time.sleep(0.25)
    raise AssertionError(f"FAILED (timeout): {label}")


try:
    with TestClient(server.app) as c:
        tok = c.post("/api/auth/login", json={"password": "legacy-pass-123"}).json()["token"]
        tok = c.post("/api/account/setup", headers=H(tok), json={"name": "Owner", "email": "o@x.test", "password": "mango-river-42"}).json()["token"]
        n = c.post("/api/wa/numbers", headers=H(tok), json={"label": "Shop", "provider": "360dialog", "phone_id": "918339039324", "token": "d360-test-key-0123456789ABCD"}).json()
        hook = n["webhook_url"].replace("https://api.example.test", "")
        now = str(int(time.time()))

        print("Receiving")
        c.post(hook, json=payload([
            {"id": "wamid.P1", "from": "919876543210", "type": "image", "timestamp": now,
             "image": {"id": "media-photo-1", "mime_type": "image/jpeg", "caption": "Order 123456789012_1 print AARAV like this"}},
            {"id": "wamid.V1", "from": "919876543210", "type": "audio", "timestamp": now,
             "audio": {"id": "media-voice-1", "mime_type": "audio/ogg; codecs=opus", "voice": True}},
            {"id": "wamid.D1", "from": "919876543210", "type": "document", "timestamp": now,
             "document": {"id": "media-gone", "mime_type": "application/pdf", "filename": "design.pdf"}},
        ]))
        th = c.get("/api/inbox/conversations/Shop/919876543210", headers=H(tok)).json()
        msgs = {m["wa_message_id"]: m for m in th["messages"]}
        p, v, d = msgs["wamid.P1"], msgs["wamid.V1"], msgs["wamid.D1"]
        check(p["kind"] == "image" and p["media_id"] == "media-photo-1" and p["media_mime"] == "image/jpeg" and "AARAV" in p["body"], "photo stored with its caption")
        check(v["kind"] == "audio" and v["media_mime"] == "audio/ogg" and v["body"] == "", "voice note stored (codec suffix trimmed)")
        check(d["media_name"] == "design.pdf" and d["body"] == "design.pdf", "file stored with its name")
        conv = c.get("/api/inbox/conversations", headers=H(tok)).json()[0]
        check(conv["last_preview"] == "[File] design.pdf", "chat list preview names the file", conv["last_preview"])
        wait_for(lambda: c.get("/api/orders?q=123456789012", headers=H(tok)).json(), "order read from the photo caption")

        print("Showing files")
        r = c.get(f"/api/inbox/media/{p['id']}", headers=H(tok))
        check(r.status_code == 200 and r.content == PHOTO and r.headers["content-type"].startswith("image/jpeg"), "photo downloaded through Charm.Studio")
        lookups = [u for m, u, h, b in calls if "attachments" in u]
        check(lookups and lookups[-1].startswith("https://waba-v2.360dialog.io/whatsapp_business/attachments/"), "360dialog media host used instead of Meta's", str(lookups))
        before = len(calls)
        check(c.get(f"/api/inbox/media/{p['id']}", headers=H(tok)).content == PHOTO and len(calls) == before, "second view served from cache")
        r = c.get(f"/api/inbox/media/{v['id']}", headers=H(tok))
        check(r.status_code == 200 and r.headers["content-type"].startswith("audio/ogg"), "voice note playable")
        r = c.get(f"/api/inbox/media/{d['id']}", headers=H(tok))
        check(r.status_code == 410 and "30 days" in r.json()["detail"], "expired file explained")
        text_id = next(m["id"] for m in th["messages"] if m["kind"] == "image")  # any id works for 401 check
        check(c.get(f"/api/inbox/media/{text_id}").status_code == 401, "files need login")
        check(c.get("/api/inbox/media/nope", headers=H(tok)).status_code == 404, "unknown message 404")

        # Meta number: Graph API lookup with the bearer token
        c.post("/api/wa/numbers", headers=H(tok), json={"label": "Meta", "phone_id": "1234567890", "token": "EAAtest-token-0123456789", "skip_check": True})
        c.post("/api/wa/webhook", json=payload([{"id": "wamid.M1", "from": "919876543210", "type": "image", "timestamp": now,
                                                  "image": {"id": "meta-photo", "mime_type": "image/png"}}]))
        mid = c.get("/api/inbox/conversations/Meta/919876543210", headers=H(tok)).json()["messages"][0]["id"]
        r = c.get(f"/api/inbox/media/{mid}", headers=H(tok))
        check(r.status_code == 200 and r.content == b"\x89PNGmeta", "Meta number's photo downloaded with its token")

        print("Phone-app echoes")
        c.post(hook, json=payload(echoes=[{"id": "wamid.E1", "from": "918339039324", "to": "919876543210", "type": "image", "timestamp": now,
                                           "image": {"id": "media-photo-1", "mime_type": "image/jpeg"}}]))
        e = [m for m in c.get("/api/inbox/conversations/Shop/919876543210", headers=H(tok)).json()["messages"] if m["wa_message_id"] == "wamid.E1"][0]
        check(e["source"] == "phone_app" and e["media_id"] == "media-photo-1", "photo sent from the phone app shows too")

        print("Sending")
        r = c.post("/api/inbox/send-media", headers=H(tok), data={"number_label": "Shop", "to": "919876543210", "caption": "Here is your preview"},
                   files={"file": ("preview.jpg", PHOTO, "image/jpeg")})
        check(r.status_code == 200, "staff photo sent", r.text)
        sent = [json.loads(b) for m, u, h, b in calls if u.endswith("/messages")][-1]
        check(sent["type"] == "image" and sent["image"] == {"id": "up1", "caption": "Here is your preview"}, "message references the uploaded file", str(sent))
        check(uploads["up1"].find(PHOTO[:20]) >= 0, "file bytes uploaded to WhatsApp")
        out = [m for m in r.json()["messages"] if m["direction"] == "out"][-1]
        check(out["kind"] == "image" and out["media_id"] == "up1" and out["source"] == "staff" and out["body"] == "Here is your preview", "sent photo stored in the chat")
        before = len(calls)
        check(c.get(f"/api/inbox/media/{out['id']}", headers=H(tok)).content == PHOTO and len(calls) == before, "sent photo shown without downloading it again")

        r = c.post("/api/inbox/send-media", headers=H(tok), data={"number_label": "Shop", "to": "919876543210", "caption": "ignored"},
                   files={"file": ("invoice.pdf", b"%PDF-1.4 test", "application/pdf")})
        sent = [json.loads(b) for m, u, h, b in calls if u.endswith("/messages")][-1]
        check(r.status_code == 200 and sent["type"] == "document" and sent["document"]["filename"] == "invoice.pdf", "PDF sent with its file name")

        r = c.post("/api/inbox/send-media", headers=H(tok), data={"number_label": "Shop", "to": "919876543210"},
                   files={"file": ("big.jpg", b"x" * (5 * 1024 * 1024 + 10), "image/jpeg")})
        check(r.status_code == 413 and "5 MB" in r.json()["detail"], "photo over 5 MB refused")
        r = c.post("/api/inbox/send-media", headers=H(tok), data={"number_label": "Shop", "to": "919876543210"},
                   files={"file": ("x.exe", b"MZ", "application/x-msdownload")})
        check(r.status_code == 400, "unsupported file type refused")
        old = int(time.time()) - 30 * 3600
        c.post(hook, json=payload([{"id": "wamid.OLD", "from": "919111111111", "type": "text", "timestamp": str(old), "text": {"body": "hi"}}]))
        r = c.post("/api/inbox/send-media", headers=H(tok), data={"number_label": "Shop", "to": "919111111111"},
                   files={"file": ("p.jpg", PHOTO, "image/jpeg")})
        check(r.status_code == 409, "files follow the 24-hour rule too")
        check(c.post("/api/inbox/send-media", data={"number_label": "Shop", "to": "919876543210"}, files={"file": ("p.jpg", PHOTO, "image/jpeg")}).status_code == 401, "sending files needs login")

        print("Export chat (like WhatsApp)")
        import io as _io
        import re as _re
        import zipfile as _zip
        exp = "/api/inbox/conversations/Shop/919876543210/export"
        r = c.get(exp, headers=H(tok), params={"tz": 330})
        txt = r.content.decode("utf-8")
        lines = txt.splitlines()
        check(r.status_code == 200 and "WhatsApp Chat with" in r.headers["content-disposition"] and ".txt" in r.headers["content-disposition"], "text export downloads as 'WhatsApp Chat with ….txt'")
        check(all(_re.match(r"^\d{2}/\d{2}/\d{2}, \d{1,2}:\d{2} (am|pm) - .+?: ", ln) for ln in lines if _re.match(r"^\d{2}/", ln)), "Android layout: 21/11/26, 12:16 pm - Name: text", lines[:3])
        check(txt.count("<Media omitted>") >= 3 and "print AARAV like this" in txt, "media omitted, captions kept")
        check("Here is your preview" in txt and "Shop: " in txt, "shop's messages included under the shop name")
        r = c.get(exp, headers=H(tok), params={"media": "true", "tz": 330})
        z = _zip.ZipFile(_io.BytesIO(r.content))
        names = z.namelist()
        inner = z.read(next(n for n in names if n.endswith(".txt"))).decode("utf-8")
        photo = next((n for n in names if _re.match(r"IMG-\d{8}-WA\d{4}\.jpg$", n)), None)
        check(r.headers["content-type"] == "application/zip" and photo and z.read(photo) == PHOTO, "zip has the .txt and the photo as IMG-yyyymmdd-WA0001.jpg", names)
        check(any(_re.match(r"PTT-\d{8}-WA\d{4}\.opus$", n) for n in names), "voice note saved as PTT-….opus", names)
        check(f"{photo} (file attached)" in inner and "design.pdf" not in names and "<Media omitted>" in inner, "attached files named in the text; expired file stays omitted")
        check(c.get(exp).status_code == 401 and c.get("/api/inbox/conversations/Shop/910000000000/export", headers=H(tok)).status_code == 404, "export needs login; unknown chat 404")

    print(f"\nALL {passed} CHECKS PASSED")
finally:
    asyncio.run(drop_schema())
    print(f"(dropped test schema {SCHEMA})")
