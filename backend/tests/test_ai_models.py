"""Check which Claude model each AI job uses (no real AI calls; nothing is billed).

WhatsApp Extract should use ANTHROPIC_EXTRACT_MODEL (default claude-sonnet-5-5) and the WhatsApp bots should use
ANTHROPIC_MODEL (here claude-haiku-5-5), with options each model accepts: effort on both, server-side refusal
fallbacks only on Sonnet (Haiku 5.5 has none).

    cd backend
    .venv/Scripts/python.exe tests/test_ai_models.py
"""
import asyncio
import os
import sys
from pathlib import Path
from types import SimpleNamespace

from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
load_dotenv(BACKEND / ".env")
os.environ.update({"AI_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "sk-ant-test-not-real", "ANTHROPIC_MODEL": "claude-haiku-5-5"})
os.environ.pop("ANTHROPIC_EXTRACT_MODEL", None)

import server  # noqa: E402

calls = []


class FakeMessages:
    async def create(self, **kw):
        calls.append(kw)
        text = '[{"order_id":"123456789012_1","product_name":"AARAV","charm":"Heart","notes":""}]'
        if "single WhatsApp message" in kw["system"]:
            text = '{"order_id":"123456789012_1","product_name":"AARAV","charm":"Heart","notes":""}'
        return SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=text)])


server._ai_client = SimpleNamespace(beta=SimpleNamespace(messages=FakeMessages()))

passed = 0


def check(cond, label, extra=""):
    global passed
    if not cond:
        raise AssertionError(f"FAILED: {label} {extra}")
    passed += 1
    print(f"  ok  {label}")


async def main():
    check(server.AI_MODEL == "claude-haiku-5-5" and server.EXTRACT_MODEL == "claude-sonnet-5-5", "models from settings: bot Haiku, Extract Sonnet")

    print("WhatsApp Extract")
    res = await server.extract(server.ExtractIn(text="Riya: order 123456789012_1, print AARAV, heart charm"))
    c = calls[-1]
    check(c["model"] == "claude-sonnet-5-5", "Extract runs on Sonnet", c["model"])
    check(c["extra_body"].get("fallbacks") == "default" and "server-side-fallback-2026-07-01" in c["betas"], "Sonnet gets refusal fallbacks")
    check(res["orders"][0]["product_name"] == "AARAV", "Extract result parsed")

    print("Bots")
    await server.ai_extract_message("Hi my order is 123456789012_1 please print AARAV with heart charm")
    c = calls[-1]
    check(c["model"] == "claude-haiku-5-5", "ask-questions bot runs on Haiku", c["model"])
    check(c["extra_body"].get("output_config") == {"effort": "low"}, "Haiku gets effort low")
    check("fallbacks" not in c["extra_body"] and not c["betas"], "no fallbacks sent to Haiku (it has none)")
    check(c["max_tokens"] == 2000, "short replies for the bot")

    print("Extract effort setting")
    server.EXTRACT_EFFORT = "high"
    server.EXTRACT_MODEL = "claude-haiku-5-5"
    await server.extract(server.ExtractIn(text="Riya: order 123456789012_1, print AARAV, heart charm"))
    c = calls[-1]
    check(c["model"] == "claude-haiku-5-5" and c["extra_body"].get("output_config") == {"effort": "high"}, "Extract on Haiku at high effort when set")
    check("fallbacks" not in c["extra_body"], "still no fallbacks for Haiku")
    server.EXTRACT_EFFORT, server.EXTRACT_MODEL = None, "claude-sonnet-5-5"
    await server.extract(server.ExtractIn(text="Riya: order 123456789012_1"))
    check("output_config" not in calls[-1]["extra_body"], "no effort sent when the setting is blank (model default)")

    print("Read-only bot")
    await server.claude_text(server.CHAT_EXTRACT_SYSTEM, "Riya: order 123456789012_1 AARAV heart", max_tokens=2000, effort="low")
    check(calls[-1]["model"] == "claude-haiku-5-5", "read-only bot runs on Haiku")


asyncio.run(main())
print(f"\nALL {passed} CHECKS PASSED")
