"""Check that WhatsApp token problems are explained plainly, and that Check spots a token that can't send.
Meta is faked, so no network or database is needed.

    cd backend
    .venv/Scripts/python.exe tests/test_token_errors.py
"""
import asyncio
import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
load_dotenv(BACKEND / ".env")
os.environ["ANTHROPIC_API_KEY"] = ""

import server  # noqa: E402
from fastapi import HTTPException  # noqa: E402

passed = 0


def check(cond, label, extra=""):
    global passed
    if not cond:
        raise AssertionError(f"FAILED: {label} {extra}")
    passed += 1
    print(f"  ok  {label}")


def resp(status, data):
    return httpx.Response(status, json=data, request=httpx.Request("POST", "https://graph.facebook.com/x"))


print("Send errors")
auth = server._api_error(resp(401, {"error": {"message": "Authorization Error", "code": 0}}))
check(auth.startswith("Authorization Error") and "Settings > WhatsApp numbers" in auth, "Authorization Error explains the token fix")
check("whatsapp_business_messaging" in server._api_error(resp(403, {"error": {"message": "(#200) Permissions error", "code": 200}})), "permission error explained")
check("Settings" in server._api_error(resp(401, {"error": {"message": "Session has expired", "code": 190}})), "expired token explained")
plain = server._api_error(resp(400, {"error": {"message": "Recipient phone number not in allowed list", "code": 131030}}))
check(plain == "Recipient phone number not in allowed list", "other errors unchanged")
check(server._api_error(resp(400, {"errors": [{"title": "Invalid recipient"}]})) == "Invalid recipient", "360dialog errors unchanged")

print("Check button")
phone_ok = {"display_phone_number": "+91 94556 58565", "verified_name": "Celed Hub Charms"}


def run_check(perm_response):
    async def handler(request):
        if request.url.path.endswith("/me/permissions"):
            if isinstance(perm_response, Exception):
                raise perm_response
            return httpx.Response(perm_response[0], json=perm_response[1])
        return httpx.Response(200, json=phone_ok)

    real = httpx.AsyncClient

    class Fake(real):
        def __init__(self, *a, **k):
            k["transport"] = httpx.MockTransport(handler)
            super().__init__(*a, **k)

    server.httpx.AsyncClient = Fake
    try:
        return asyncio.run(server.meta_check("1358380210688602", "token"))
    except HTTPException as e:
        return e
    finally:
        server.httpx.AsyncClient = real


grant = lambda *names: (200, {"data": [{"permission": n, "status": "granted"} for n in names]})  # noqa: E731
r = run_check(grant("whatsapp_business_management"))
check(isinstance(r, HTTPException) and "can't send" in r.detail, "token without sending permission is caught", r)
r = run_check(grant("whatsapp_business_management", "whatsapp_business_messaging"))
check(isinstance(r, dict) and r["verified_name"] == "Celed Hub Charms", "token with both permissions passes")
check(isinstance(run_check((400, {"error": {"message": "unsupported"}})), dict), "permissions unknown: saving isn't blocked")
check(isinstance(run_check(httpx.ConnectError("down")), dict), "permissions lookup fails: saving isn't blocked")

print(f"\nALL {passed} CHECKS PASSED")
