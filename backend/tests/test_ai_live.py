"""LIVE check of how well Claude reads charm orders from real-looking WhatsApp chats, and what it costs.

This makes REAL API calls and is billed to the ANTHROPIC_API_KEY in backend/.env (a few cents per run).
It skips itself when no key is set. Each case runs through the same prompts the app uses:
  - the read-only bot's chat reading (CHAT_EXTRACT_SYSTEM)
  - WhatsApp Extract (EXTRACT_SYSTEM)
for each setup below, then prints fields correct and the measured cost, so you can pick the
Extract setting (ANTHROPIC_EXTRACT_MODEL / ANTHROPIC_EXTRACT_EFFORT) with numbers, not guesses.

    cd backend
    .venv/Scripts/python.exe tests/test_ai_live.py                    # all setups
    .venv/Scripts/python.exe tests/test_ai_live.py haiku-high sonnet  # some of them
"""
import asyncio
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
load_dotenv(BACKEND / ".env")
os.environ["AI_PROVIDER"] = "anthropic"
if not os.environ.get("ANTHROPIC_API_KEY", "").strip():
    print("SKIPPED: put ANTHROPIC_API_KEY=sk-ant-... in backend/.env to run the live check.")
    sys.exit(0)

import server  # noqa: E402

# name -> (model, effort). "low" is what the bots use today; the Extract page uses ANTHROPIC_EXTRACT_* settings.
SETUPS = {
    "haiku-low": ("claude-haiku-5-5", "low"),
    "haiku-high": ("claude-haiku-5-5", "high"),
    "sonnet": ("claude-sonnet-5-5", None),  # Sonnet's default effort (high)
}
PRICES = {"claude-haiku-5-5": (0.10, 0.50), "claude-sonnet-5-5": (2.00, 10.00)}  # $ per million tokens (in, out)
INR_PER_USD = 90

# (description, chat text, expected orders) - expected values compared case-insensitively
CASES = [
    ("plain English", "Riya: Hi, order 123456789012_1. Please print AARAV with a heart charm.",
     [{"order_id": "123456789012_1", "product_name": "AARAV", "charm": "heart"}]),
    ("Hinglish", "Kabir: bhaiya mera order OD432198765432109876 hai, naam Meera likhna aur star wala charm dalna, gift wrap kar dena",
     [{"order_id": "OD432198765432109876", "product_name": "Meera", "charm": "star"}]),
    ("correction", "Neha: Order 112233445566_1, name SAANVI, rose gold charm\nNeha: sorry spelling galat, make it SAANVII\nNeha: rose gold hi rahega",
     [{"order_id": "112233445566_1", "product_name": "SAANVII", "charm": "rose gold"}]),
    ("two orders in one chat", "Priya: I placed two orders\nPriya: 987654321098_1 - ISHAAN, moon charm\nPriya: 987654321098_2 - ANAYA, butterfly charm, pack separately",
     [{"order_id": "987654321098_1", "product_name": "ISHAAN", "charm": "moon"},
      {"order_id": "987654321098_2", "product_name": "ANAYA", "charm": "butterfly"}]),
    ("small talk + details later", "Rohan: hello\nShop: Hi! How can we help?\nRohan: delivery kab tak hogi?\nShop: 5-7 days\nRohan: ok. order id 556677889900_1, name ZOYA, flower charm please",
     [{"order_id": "556677889900_1", "product_name": "ZOYA", "charm": "flower"}]),
    ("no order in chat", "Ananya: Is the butterfly charm available in gold?\nShop: Yes it is!\nAnanya: great, will order tomorrow", []),
]


def norm(v):
    return " ".join(str(v or "").lower().replace("-", " ").split())


def score(found, expected):
    """Return (correct_fields, total_fields, notes)."""
    total, ok, notes = 0, 0, []
    if not expected:
        bad = [f for f in found if f.get("order_id")]
        return (0 if bad else 1), 1, ([f"invented {len(bad)} order(s)"] if bad else [])
    for exp in expected:
        match = next((f for f in found if server.ids_match(f.get("order_id", ""), exp["order_id"])), None)
        for k, v in exp.items():
            total += 1
            got = (match or {}).get(k, "")
            if match and (norm(v) == norm(got) or (k == "charm" and norm(v) in norm(got))):
                ok += 1
            else:
                notes.append(f"{k}: expected '{v}', got '{got}'")
    extra = len([f for f in found if f.get("order_id")]) - len(expected)
    if extra > 0:
        notes.append(f"{extra} extra order(s)")
    return ok, total, notes


def cost_of(calls):
    usd = 0.0
    for c in calls:
        pin, pout = PRICES.get(c["model"], (0, 0))
        usd += c["input"] * pin / 1e6 + c["output"] * pout / 1e6
    return usd


async def run(name):
    model, effort = SETUPS[name]
    print(f"\n=== {name}: {model}, effort {effort or 'default'} ===")
    summary = {}
    for prompt_name, system in (("read-only bot", server.CHAT_EXTRACT_SYSTEM), ("WhatsApp Extract", server.EXTRACT_SYSTEM)):
        print(f"-- {prompt_name}")
        ok_sum = total_sum = 0
        start = len(server.AI_USAGE)
        for desc, chat, expected in CASES:
            t0 = time.time()
            try:
                found = server.parse_orders(await server.claude_text(system, chat, max_tokens=4000, model=model, effort=effort))
                err = ""
            except Exception as e:  # noqa: BLE001
                found, err = [], str(e)[:120]
            ok, total, notes = score(found, expected)
            ok_sum += ok
            total_sum += total
            mark = "ok  " if ok == total and not err else "MISS"
            print(f"  {mark} {desc:28s} {ok}/{total}  {time.time() - t0:4.1f}s  {err or '; '.join(notes)}")
        usd = cost_of(server.AI_USAGE[start:])
        summary[prompt_name] = (ok_sum, total_sum, usd)
        print(f"  => {ok_sum}/{total_sum} fields correct; {len(CASES)} calls cost ${usd:.4f} (≈ ₹{usd * INR_PER_USD:.2f})")
    return summary


async def main():
    names = [a for a in sys.argv[1:] if a in SETUPS] or list(SETUPS)
    results = {n: await run(n) for n in names}
    print("\n=== Summary (WhatsApp Extract prompt) ===")
    print(f"  {'setup':12s} {'accuracy':>10s} {'cost / 6 chats':>16s}")
    for n, r in results.items():
        ok, total, usd = r["WhatsApp Extract"]
        print(f"  {n:12s} {100 * ok // max(total, 1):>9d}% {f'${usd:.4f}':>16s}")
    print("\nTo use a setup for WhatsApp Extract, set on Render: ANTHROPIC_EXTRACT_MODEL and ANTHROPIC_EXTRACT_EFFORT.")


asyncio.run(main())
