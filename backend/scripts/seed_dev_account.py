"""Create or replace the owner account in a LOCAL development schema.

Skips the in-app password rules, so simple test passwords work. It refuses to run unless
DB_SCHEMA is set (in backend/.env or the environment), so it can never touch the live
tables in the shared database.

    cd backend
    .venv/Scripts/python.exe scripts/seed_dev_account.py --email test@charm.local --password <pw> [--name "Test Account"]
"""
import argparse
import asyncio
import os
import re
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
load_dotenv(BACKEND / ".env")

from security import hash_password  # noqa: E402


async def main(email: str, password: str, name: str) -> None:
    schema = os.environ.get("DB_SCHEMA", "").strip()
    if not schema or schema == "public" or not re.fullmatch(r"[a-z_][a-z0-9_]{0,40}", schema):
        sys.exit("Refusing to run: set DB_SCHEMA (e.g. charm_dev) so the live account isn't touched.")
    conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
    try:
        await conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
        await conn.execute(f'SET search_path TO "{schema}"')
        await conn.execute((BACKEND / "schema.sql").read_text(encoding="utf-8"))
        await conn.execute(
            "UPDATE account SET name = $1, email = $2, password_hash = $3, password_changed_at = now(), "
            "token_version = token_version + 1, updated_at = now() WHERE id = 1",
            name,
            email.strip().lower(),
            hash_password(password),
        )
        row = await conn.fetchrow("SELECT current_schema() AS s, name, email FROM account WHERE id = 1")
        print(f"Account ready in schema '{row['s']}': {row['name']} <{row['email']}>")
    finally:
        await conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--name", default="Test Account")
    args = ap.parse_args()
    asyncio.run(main(args.email, args.password, args.name))
