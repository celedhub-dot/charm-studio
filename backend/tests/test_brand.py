"""Check the app logo: the WhatsApp Business profile picture from Meta, cached in the database.

Runs the real app against a throwaway Postgres schema ("charm_test_brand"); Meta is faked.

    cd backend
    .venv/Scripts/python.exe tests/test_brand.py
"""
import asyncio
import os
import secrets
import sys
from pathlib import Path

import asyncpg
import httpx
from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
load_dotenv(BACKEND / ".env")

SCHEMA = "charm_test_brand"
os.environ.update({"DB_SCHEMA": SCHEMA, "AUTH_SECRET": secrets.token_urlsafe(48), "ADMIN_PASSWORD": "legacy-pass-123",
                   "RESET_PASSWORD": "", "WA_NUMBERS": "", "ANTHROPIC_API_KEY": ""})


async def drop_schema():
    conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
    await conn.execute(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE')
    await conn.close()


asyncio.run(drop_schema())

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

PICTURE = b"\xff\xd8\xff\xe0" + b"profile-picture" * 20
state = {"meta_up": True, "has_picture": True, "lookups": 0}


async def fake_meta_check(phone_id, token):
    return {"display_phone_number": "+91 94556 58565", "verified_name": "Celed Hub Charms"}


def handler(request: httpx.Request):
    if not state["meta_up"]:
        raise httpx.ConnectError("Meta unreachable")
    if request.url.path.endswith("/whatsapp_business_profile"):
        state["lookups"] += 1
        assert request.headers["authorization"] == "Bearer EAAtest-token-0123456789"
        url = "https://pps.whatsapp.net/v/t61/photo.jpg" if state["has_picture"] else ""
        return httpx.Response(200, json={"data": [{"profile_picture_url": url}]})
    if request.url.host == "pps.whatsapp.net":
        return httpx.Response(200, content=PICTURE, headers={"content-type": "image/jpeg"})
    return httpx.Response(404)


real_client = httpx.AsyncClient


class FakeClient(real_client):
    def __init__(self, *a, **k):
        k["transport"] = httpx.MockTransport(handler)
        super().__init__(*a, **k)


server.meta_check = fake_meta_check
server.httpx.AsyncClient = FakeClient
passed = 0


def check(cond, label, extra=""):
    global passed
    if not cond:
        raise AssertionError(f"FAILED: {label} {extra}")
    passed += 1
    print(f"  ok  {label}")


def H(t):
    return {"Authorization": f"Bearer {t}"}


def reset_cache():
    server.BRAND.update(data=None, mime="", at=0.0, tried=0.0, loaded=False)


try:
    with TestClient(server.app) as c:
        print("No number yet")
        check(c.get("/api/brand").json() == {"has_logo": False, "version": ""}, "no logo before a number is added")
        check(c.get("/api/brand/logo").status_code == 404, "logo 404 so the app shows its own icon")

        tok = c.post("/api/auth/login", json={"password": "legacy-pass-123"}).json()["token"]
        tok = c.post("/api/account/setup", headers=H(tok), json={"name": "Owner", "email": "o@x.test", "password": "mango-river-42"}).json()["token"]
        r = c.post("/api/wa/numbers", headers=H(tok), json={"label": "Order desk", "provider": "meta", "phone_id": "1358380210688602", "token": "EAAtest-token-0123456789"})
        check(r.status_code in (200, 201), "Meta number added", r.text)

        print("Picture from Meta")
        reset_cache()
        info = c.get("/api/brand").json()
        check(info["has_logo"] and info["version"], "logo found in the WhatsApp Business profile", info)
        r = c.get("/api/brand/logo")
        check(r.status_code == 200 and r.content == PICTURE and r.headers["content-type"] == "image/jpeg", "picture served without login (for the favicon)")
        before = state["lookups"]
        c.get("/api/brand/logo")
        check(state["lookups"] == before, "served from cache, Meta not asked again")

        print("After a restart, with Meta unreachable")
        reset_cache()
        state["meta_up"] = False
        r = c.get("/api/brand/logo")
        check(r.status_code == 200 and r.content == PICTURE, "picture kept in the database")
        state["meta_up"] = True

        print("Refresh")
        check(c.post("/api/brand/refresh").status_code == 401, "refresh needs login")
        state["has_picture"] = False
        r = c.post("/api/brand/refresh", headers=H(tok)).json()
        check(r["has_logo"] and r["version"] == info["version"], "picture removed in Meta: keep showing the last one")
        state["has_picture"] = True

    print(f"\nALL {passed} CHECKS PASSED")
finally:
    server.httpx.AsyncClient = real_client
    asyncio.run(drop_schema())
    print(f"(dropped test schema {SCHEMA})")
