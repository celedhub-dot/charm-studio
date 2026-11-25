"""WhatsApp Extract's model: Haiku by default, a team-wide default the owner can change, and the model the
page picks is the one actually sent to the AI (checked on the call itself, not just the reply).

Runs the real app against a throwaway Postgres schema ("charm_test_extract"); the AI is faked.

    cd backend
    .venv/Scripts/python.exe tests/test_extract_defaults.py
"""
import asyncio
import io
import os
import secrets
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
load_dotenv(BACKEND / ".env")

SCHEMA = "charm_test_extract"
for k in ("ANTHROPIC_EXTRACT_MODEL", "ANTHROPIC_EXTRACT_EFFORT"):
    os.environ.pop(k, None)  # test the built-in default
os.environ.update({"DB_SCHEMA": SCHEMA, "AUTH_SECRET": secrets.token_urlsafe(48), "ADMIN_PASSWORD": "legacy-pass-123",
                   "RESET_PASSWORD": "", "WA_NUMBERS": "", "ANTHROPIC_API_KEY": "sk-ant-test-not-real", "AI_PROVIDER": "anthropic",
                   "PUBLIC_BASE_URL": "https://api.example.test"})


async def drop_schema():
    conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
    await conn.execute(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE')
    await conn.close()


asyncio.run(drop_schema())

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

calls = []


async def fake_claude(system, user, max_tokens=16000, effort=None, model=None):
    calls.append((model, effort))
    return "[]"


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


try:
    with TestClient(server.app) as c:
        tok = c.post("/api/auth/login", json={"password": "legacy-pass-123"}).json()["token"]
        tok = c.post("/api/account/setup", headers=H(tok), json={"name": "Owner", "email": "o@x.test", "password": "mango-river-42"}).json()["token"]

        def extract(**ai):
            calls.clear()
            r = c.post("/api/extract", headers=H(tok), json={"text": "order 123456789012_1 name AARAV", **ai})
            assert r.status_code == 200, r.text
            return calls[-1], r.json()

        def extract_file(**ai):
            calls.clear()
            r = c.post("/api/extract/bulk-file", headers=H(tok), data={k: v for k, v in ai.items()},
                       files={"file": ("chat.txt", io.BytesIO(b"[1/1/26, 10:00:00 AM] A: order 123456789012_1"), "text/plain")})
            assert r.status_code == 200, r.text
            return calls[-1]

        print("Built-in default")
        o = c.get("/api/extract/options", headers=H(tok)).json()
        check(o["default"] == {"model": "claude-haiku-5-5", "effort": "medium"} and o["can_set_default"], "Haiku, medium", o["default"])
        sent, res = extract()
        check(sent == ("claude-haiku-5-5", "medium") and res["model"] == "claude-haiku-5-5", "paste with 'Default' calls Haiku medium", sent)
        check(extract_file() == ("claude-haiku-5-5", "medium"), "chat file with 'Default' calls Haiku medium")

        print("Picking a model on the page")
        check(extract(model="claude-sonnet-5-5", effort="low")[0] == ("claude-sonnet-5-5", "low"), "Sonnet low is what gets called")
        check(extract_file(model="claude-sonnet-5-5", effort="high") == ("claude-sonnet-5-5", "high"), "chat file uses the picked model too")
        check(c.post("/api/extract", headers=H(tok), json={"text": "x", "model": "gpt-4"}).status_code == 400, "unknown model refused")

        print("Owner changes the default for everyone")
        r = c.put("/api/settings/ai", headers=H(tok), json={"extract_model": "claude-sonnet-5-5", "extract_effort": "low"})
        check(r.status_code == 200, "saved", r.text)
        o = c.get("/api/extract/options", headers=H(tok)).json()
        check(o["default"] == {"model": "claude-sonnet-5-5", "effort": "low"}, "options show the new default", o["default"])
        check(extract()[0] == ("claude-sonnet-5-5", "low"), "'Default' now actually calls Sonnet low")
        check(extract(model="claude-haiku-5-5")[0][0] == "claude-haiku-5-5", "a device's own pick still wins")
        check(c.put("/api/settings/ai", headers=H(tok), json={"extract_model": "nope"}).status_code == 400, "bad model refused")
        c.put("/api/settings/ai", headers=H(tok), json={"extract_model": "claude-haiku-5-5", "extract_effort": "medium"})
        check(extract()[0] == ("claude-haiku-5-5", "medium"), "back to Haiku medium")
        check(c.put("/api/settings/ai", json={"extract_model": "claude-haiku-5-5"}).status_code == 401, "needs login")

    print(f"\nALL {passed} CHECKS PASSED")
finally:
    asyncio.run(drop_schema())
    print(f"(dropped test schema {SCHEMA})")
