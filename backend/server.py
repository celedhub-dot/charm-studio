"""Charm.Studio backend.

FastAPI + asyncpg (Supabase Postgres) + PyMuPDF + Anthropic SDK.
All routes are mounted under /api.
"""
import asyncio
import base64
import csv
import hashlib
import hmac
import html
import io
import json
import logging
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

import asyncpg
import pymupdf as fitz
import httpx
from anthropic import AsyncAnthropic
from dotenv import load_dotenv
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware

from security import (
    SecretBox,
    hash_password,
    new_reset_token,
    password_problem,
    read_token,
    sha256_hex,
    sign_token,
    verify_password,
)

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("charm_studio")

DATABASE_URL = os.environ["DATABASE_URL"]
ORDER_FIELDS = ("order_id", "product_name", "charm", "notes")
ORDER_COLUMNS = "id, order_id, product_name, charm, notes, source, channel, created_at"
SOURCES = ("manual", "ai", "csv", "whatsapp")

SCHEMA_SQL = (ROOT_DIR / "schema.sql").read_text(encoding="utf-8")

pool: Optional[asyncpg.Pool] = None


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: Any) -> Any:
    return value.isoformat() if isinstance(value, datetime) else value


def row_dict(row: Optional[asyncpg.Record]) -> Optional[Dict[str, Any]]:
    if row is None:
        return None
    return {k: iso(v) for k, v in dict(row).items()}


async def _init_conn(conn: asyncpg.Connection):
    for typ in ("json", "jsonb"):
        await conn.set_type_codec(typ, encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


def db() -> asyncpg.Pool:
    if pool is None:
        raise HTTPException(503, "Database not ready")
    return pool


# ---------------------------------------------------------------------------
# Configuration from the environment
# ---------------------------------------------------------------------------
WA_GRAPH_VERSION = os.environ.get("WA_GRAPH_VERSION", "v20.0")
WA_VERIFY_TOKEN = os.environ.get("WA_VERIFY_TOKEN", "").strip()


def _env_secret(name: str, min_len: int) -> str:
    """Read a secret env var, ignoring unset, too-short or unedited "<placeholder>" values."""
    value = os.environ.get(name, "")
    return value if len(value) >= min_len and not value.startswith("<") else ""


AUTH_SECRET = _env_secret("AUTH_SECRET", 32)
LEGACY_ADMIN_PASSWORD = _env_secret("ADMIN_PASSWORD", 8)  # only used for the very first login
RESET_PASSWORD = _env_secret("RESET_PASSWORD", 8)  # emergency way back in; remove after use
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "").strip()
RESEND_FROM = os.environ.get("RESEND_FROM", "").strip() or "Charm.Studio <onboarding@resend.dev>"
FRONTEND_URL = os.environ.get("FRONTEND_URL", "").strip().rstrip("/")
CORS_ORIGINS = [
    o.strip().rstrip("/") for o in os.environ.get("CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()
]
# Optional, e.g. https://charm-studio-[a-z0-9]+-you\.vercel\.app to also allow Vercel preview deployments
CORS_ORIGIN_REGEX = os.environ.get("CORS_ORIGIN_REGEX", "").strip() or None

if not AUTH_SECRET:
    log.error("AUTH_SECRET is missing or shorter than 32 characters: login and saved WhatsApp tokens won't work.")

# Encrypts secrets stored in the database (WhatsApp tokens). Derived from AUTH_SECRET.
secret_box = SecretBox(AUTH_SECRET or "auth-secret-not-set", "charm-studio:secrets")


def env_wa_numbers() -> List[Dict[str, str]]:
    """Numbers configured the old way (WA_NUMBERS + WA_<ID>_*). Imported into the database once."""
    found = []
    for logical_id in [x.strip() for x in os.environ.get("WA_NUMBERS", "").split(",") if x.strip()]:
        key = logical_id.upper()
        phone_id = os.environ.get(f"WA_{key}_PHONE_ID", "").strip()
        token = os.environ.get(f"WA_{key}_TOKEN", "").strip()
        if phone_id and token and not phone_id.startswith("<") and not token.startswith("<"):
            found.append(
                {
                    "label": logical_id,
                    "phone_id": phone_id,
                    "token": token,
                    "display": os.environ.get(f"WA_{key}_DISPLAY", "").strip(),
                    "verify": os.environ.get(f"WA_{key}_VERIFY", "").strip(),
                }
            )
    return found


# ---------------------------------------------------------------------------
# In-memory caches (single process): account, settings, WhatsApp numbers.
# Reloaded from the database at startup and after every change.
# ---------------------------------------------------------------------------
ACCOUNT: Dict[str, Any] = {}
SETTINGS: Dict[str, Dict[str, Any]] = {}
WA_ALL: List[Dict[str, Any]] = []  # every saved number; "token" is None if it can't be decrypted
WA_NUMBERS: Dict[str, Dict[str, Any]] = {}  # phone_id -> config, only active numbers with a readable token

DEFAULT_SETTINGS: Dict[str, Dict[str, Any]] = {
    "shop": {"shop_name": ""},
    "bot": {
        "ask_order_id": "Hi! Please send your Order ID.",
        "ask_product_name": "What name should we print on the product?",
        "ask_charm": "Which charm would you like?",
        "ask_notes": "Any notes? Reply 'none' to skip.",
        "thank_you": (
            "Thank you! Your order details are saved.\n\n"
            "Order ID: {order_id}\nName: {name}\nCharm: {charm}\nNotes: {notes}"
        ),
    },
    "labels": {"position": "bottom-right", "font_size": 8, "skip_unmatched": False},
}


async def load_account() -> None:
    row = await db().fetchrow("SELECT * FROM account WHERE id = 1")
    ACCOUNT.clear()
    ACCOUNT.update(dict(row))


async def update_account(**fields: Any) -> None:
    cols = list(fields)  # column names come from our own code, never from requests
    sets = ", ".join(f"{c} = ${i + 1}" for i, c in enumerate(cols))
    row = await db().fetchrow(
        f"UPDATE account SET {sets}, updated_at = now() WHERE id = 1 RETURNING *", *[fields[c] for c in cols]
    )
    ACCOUNT.clear()
    ACCOUNT.update(dict(row))


async def load_settings() -> None:
    rows = await db().fetch("SELECT key, value FROM app_settings")
    stored = {r["key"]: r["value"] for r in rows}
    SETTINGS.clear()
    for section, defaults in DEFAULT_SETTINGS.items():
        saved = stored.get(section) if isinstance(stored.get(section), dict) else {}
        SETTINGS[section] = {**defaults, **{k: v for k, v in saved.items() if k in defaults}}


async def save_setting(key: str, value: Dict[str, Any]) -> None:
    await db().execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now()) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        key,
        value,
    )


def _decrypt_or_none(value: str) -> Optional[str]:
    try:
        return secret_box.decrypt(value)
    except ValueError:
        return None


async def load_wa_numbers() -> None:
    rows = await db().fetch("SELECT * FROM wa_numbers ORDER BY created_at")
    WA_ALL.clear()
    WA_NUMBERS.clear()
    for r in rows:
        token = _decrypt_or_none(r["token_enc"])
        verify = (_decrypt_or_none(r["verify_token_enc"]) or "") if r["verify_token_enc"] else ""
        cfg = {
            "id": r["id"],
            "label": r["label"],
            "logical_id": r["label"],  # used as conversation key and order "channel"
            "phone_id": r["phone_id"],
            "display": r["display"],
            "token": token,
            "token_last4": r["token_last4"],
            "verify": verify,
            "active": r["active"],
            "created_at": iso(r["created_at"]),
        }
        WA_ALL.append(cfg)
        if r["active"] and token:
            WA_NUMBERS[r["phone_id"]] = cfg
    if any(c["token"] is None for c in WA_ALL):
        log.warning("Some saved WhatsApp tokens can't be decrypted (was AUTH_SECRET changed?). Re-enter them in Settings.")


async def import_env_wa_numbers() -> None:
    """Copy numbers from the old WA_* env vars into the database, once."""
    if await db().fetchval("SELECT 1 FROM app_settings WHERE key = 'wa_env_imported'"):
        return
    imported = 0
    for n in env_wa_numbers():
        res = await db().execute(
            "INSERT INTO wa_numbers (id, label, display, phone_id, token_enc, token_last4, verify_token_enc) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING",
            str(uuid.uuid4()),
            n["label"],
            n["display"],
            n["phone_id"],
            secret_box.encrypt(n["token"]),
            n["token"][-4:],
            secret_box.encrypt(n["verify"]) if n["verify"] else "",
        )
        imported += res.endswith(" 1")
    await save_setting("wa_env_imported", {"at": now_utc().isoformat(), "count": imported})
    if imported:
        log.info("Imported %d WhatsApp number(s) from environment variables into Settings.", imported)


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(_: FastAPI):
    global pool
    # Optional DB_SCHEMA puts all tables in a separate Postgres schema, e.g. a throwaway
    # "charm_test" schema for local testing against the same database as production.
    schema = os.environ.get("DB_SCHEMA", "").strip()
    if schema and not re.fullmatch(r"[a-z_][a-z0-9_]{0,40}", schema):
        raise RuntimeError("DB_SCHEMA must be lowercase letters, digits or underscores.")
    if schema:
        conn = await asyncpg.connect(DATABASE_URL, statement_cache_size=0)
        await conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
        await conn.close()
    # statement_cache_size=0 keeps asyncpg compatible with Supabase's transaction pooler (pgbouncer).
    pool = await asyncpg.create_pool(
        DATABASE_URL,
        min_size=1,
        max_size=int(os.environ.get("DB_POOL_SIZE", "5")),
        statement_cache_size=0,
        init=_init_conn,
        command_timeout=60,
        server_settings={"search_path": schema} if schema else None,
    )
    async with pool.acquire() as conn:
        if schema:
            assert await conn.fetchval("SELECT current_schema()") == schema, "search_path not applied"
        await conn.execute(SCHEMA_SQL)
    await load_account()
    await load_settings()
    if AUTH_SECRET:
        await import_env_wa_numbers()
    await load_wa_numbers()
    log.info(
        "Charm.Studio ready. Account set up: %s. WhatsApp numbers: %d saved, %d active.",
        not needs_setup(),
        len(WA_ALL),
        len(WA_NUMBERS),
    )
    if RESET_PASSWORD:
        log.warning("RESET_PASSWORD is set. Log in with it, choose a new password, then remove it from the environment.")
    yield
    await pool.close()


app = FastAPI(title="Charm.Studio API", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Authentication
#
# One owner account (table `account`). Login with email + password returns a
# signed bearer token. Its "scope" is:
#   full     - normal access
#   setup    - first login (via ADMIN_PASSWORD): may only finish account setup
#   password - logged in via RESET_PASSWORD: may only choose a new password
# The signing key mixes AUTH_SECRET, the password hash and a token_version, so
# changing the password or pressing "log out all other devices" invalidates
# every token issued before.
# ---------------------------------------------------------------------------
SCOPED_TOKEN_SECONDS = 3600
_LOGIN_WINDOW_S = 15 * 60
_LOGIN_MAX_FAILS = 10
_FORGOT_MAX = 5
_login_failures: Dict[str, List[float]] = {}
_forgot_requests: Dict[str, List[float]] = {}
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def needs_setup() -> bool:
    return not ACCOUNT.get("password_hash")


def auth_problem() -> Optional[str]:
    if not AUTH_SECRET:
        return "Login is not set up on the server: set AUTH_SECRET (32+ random characters)."
    if needs_setup() and not (LEGACY_ADMIN_PASSWORD or RESET_PASSWORD):
        return "Login is not set up on the server: set ADMIN_PASSWORD (8+ characters) for the first login."
    return None


def signing_key() -> bytes:
    basis = ACCOUNT.get("password_hash") or ("legacy:" + LEGACY_ADMIN_PASSWORD)
    material = f"charm-studio:v2:{basis}:{ACCOUNT.get('token_version', 1)}"
    return hmac.new(AUTH_SECRET.encode(), material.encode(), hashlib.sha256).digest()


def make_token(scope: str = "full", now: Optional[float] = None) -> Dict[str, Any]:
    now = time.time() if now is None else now
    life = int(ACCOUNT.get("session_days") or 30) * 86400 if scope == "full" else SCOPED_TOKEN_SECONDS
    exp = int(now + life)
    token = sign_token(signing_key(), {"sub": "owner", "scope": scope, "iat": int(now), "exp": exp})
    return {"token": token, "scope": scope, "expires_at": datetime.fromtimestamp(exp, timezone.utc).isoformat()}


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "unknown")


def _recent(store: Dict[str, List[float]], key: str, window: float) -> List[float]:
    now = time.time()
    hits = [t for t in store.get(key, []) if now - t < window]
    store[key] = hits
    return hits


async def require_session(request: Request) -> Dict[str, Any]:
    """Any valid token, whatever its scope."""
    problem = auth_problem()
    if problem:
        raise HTTPException(503, problem)
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    claims = read_token(signing_key(), token.strip()) if scheme.lower() == "bearer" and token else None
    if not claims or claims.get("sub") != "owner":
        raise HTTPException(401, "Please log in again.", headers={"WWW-Authenticate": "Bearer"})
    return claims


async def require_full(claims: Dict[str, Any] = Depends(require_session)) -> Dict[str, Any]:
    if claims.get("scope") != "full":
        raise HTTPException(403, "Finish setting up your account first.")
    return claims


# Routers: `public` needs no login, `session` accepts any valid token (account
# setup / forced password change), `api` requires a normal full-access token.
public = APIRouter(prefix="/api")
session = APIRouter(prefix="/api", dependencies=[Depends(require_session)])
api = APIRouter(prefix="/api", dependencies=[Depends(require_full)])


async def record_login(request: Request, method: str, success: bool) -> None:
    try:
        await db().execute(
            "INSERT INTO login_events (ip, user_agent, method, success) VALUES ($1, $2, $3, $4)",
            client_ip(request),
            (request.headers.get("user-agent") or "")[:300],
            method,
            success,
        )
        await db().execute("DELETE FROM login_events WHERE at < now() - interval '90 days'")
    except Exception:  # noqa: BLE001
        log.exception("Could not record login event")


def clean_name(name: str) -> str:
    name = " ".join((name or "").split())
    if not 1 <= len(name) <= 60:
        raise HTTPException(400, "Enter your name (up to 60 characters).")
    return name


def clean_email(email: str) -> str:
    email = (email or "").strip().lower()
    if len(email) > 254 or not EMAIL_RE.match(email):
        raise HTTPException(400, "Enter a valid email address.")
    return email


def check_new_password(password: str, email: str) -> None:
    problem = password_problem(password, email)
    if problem:
        raise HTTPException(400, problem)


def account_public() -> Dict[str, Any]:
    return {
        "name": ACCOUNT.get("name", ""),
        "email": ACCOUNT.get("email", ""),
        "session_days": ACCOUNT.get("session_days", 30),
        "password_changed_at": iso(ACCOUNT.get("password_changed_at")),
        "created_at": iso(ACCOUNT.get("created_at")),
    }


class LoginIn(BaseModel):
    email: str = ""
    password: str


class SetupIn(BaseModel):
    name: str
    email: str
    password: str


class PasswordIn(BaseModel):
    current_password: str = ""
    new_password: str


class ProfileIn(BaseModel):
    name: str
    email: str
    current_password: str = ""


class SessionLengthIn(BaseModel):
    session_days: int


class ForgotIn(BaseModel):
    email: str


class ResetIn(BaseModel):
    token: str
    password: str


@public.get("/auth/config")
async def auth_config():
    """What the login screen should show (no secrets)."""
    return {
        "setup_required": needs_setup(),
        "password_reset_email": bool(RESEND_API_KEY) and bool(ACCOUNT.get("email")) and not needs_setup(),
        "problem": auth_problem(),
    }


@public.post("/auth/login")
async def login(payload: LoginIn, request: Request):
    problem = auth_problem()
    if problem:
        raise HTTPException(503, problem)
    ip = client_ip(request)
    if len(_recent(_login_failures, ip, _LOGIN_WINDOW_S)) >= _LOGIN_MAX_FAILS:
        raise HTTPException(429, "Too many wrong attempts. Try again in 15 minutes.")

    password = payload.password or ""
    account_email = (ACCOUNT.get("email") or "").lower()
    email_ok = not account_email or (payload.email or "").strip().lower() == account_email
    scope, method = None, "password"
    if RESET_PASSWORD and email_ok and hmac.compare_digest(password.encode(), RESET_PASSWORD.encode()):
        scope, method = ("setup" if needs_setup() else "password"), "reset_override"
    elif needs_setup():
        if LEGACY_ADMIN_PASSWORD and hmac.compare_digest(password.encode(), LEGACY_ADMIN_PASSWORD.encode()):
            scope, method = "setup", "first_login"
    elif email_ok and verify_password(password, ACCOUNT["password_hash"]):
        scope = "full"

    if not scope:
        _login_failures.setdefault(ip, []).append(time.time())
        log.warning("Failed login from %s", ip)
        await record_login(request, method, False)
        raise HTTPException(401, "Wrong password." if needs_setup() else "Wrong email or password.")
    _login_failures.pop(ip, None)
    await record_login(request, method, True)
    return make_token(scope)


@session.get("/auth/me")
async def auth_me(claims: Dict[str, Any] = Depends(require_session)):
    return {
        **account_public(),
        "scope": claims.get("scope"),
        "expires_at": datetime.fromtimestamp(claims["exp"], timezone.utc).isoformat(),
        "reset_override_active": bool(RESET_PASSWORD),
    }


@session.post("/account/setup")
async def account_setup(payload: SetupIn, request: Request, claims: Dict[str, Any] = Depends(require_session)):
    if claims.get("scope") != "setup" or not needs_setup():
        raise HTTPException(409, "Your account is already set up.")
    name, email = clean_name(payload.name), clean_email(payload.email)
    check_new_password(payload.password, email)
    await update_account(
        name=name,
        email=email,
        password_hash=hash_password(payload.password),
        password_changed_at=now_utc(),
        token_version=int(ACCOUNT.get("token_version", 1)) + 1,
    )
    await record_login(request, "account_setup", True)
    return make_token("full")


@session.post("/account/password")
async def change_password(payload: PasswordIn, request: Request, claims: Dict[str, Any] = Depends(require_session)):
    scope = claims.get("scope")
    if scope == "setup" or needs_setup():
        raise HTTPException(409, "Finish setting up your account first.")
    if scope == "full" and not verify_password(payload.current_password or "", ACCOUNT["password_hash"]):
        raise HTTPException(400, "Your current password is wrong.")
    check_new_password(payload.new_password, ACCOUNT.get("email", ""))
    if verify_password(payload.new_password, ACCOUNT["password_hash"]):
        raise HTTPException(400, "That's your current password. Choose a new one.")
    await update_account(
        password_hash=hash_password(payload.new_password),
        password_changed_at=now_utc(),
        token_version=int(ACCOUNT.get("token_version", 1)) + 1,
    )
    await record_login(request, "password_changed", True)
    return make_token("full")  # keeps this device logged in; every other device is logged out


@api.get("/account")
async def get_account():
    return account_public()


@api.put("/account/profile")
async def update_profile(payload: ProfileIn, request: Request):
    name, email = clean_name(payload.name), clean_email(payload.email)
    if email != (ACCOUNT.get("email") or "").lower():
        if not verify_password(payload.current_password or "", ACCOUNT["password_hash"]):
            raise HTTPException(400, "Enter your current password to change your email.")
        await record_login(request, "email_changed", True)
    await update_account(name=name, email=email)
    return account_public()


@api.put("/account/session")
async def update_session_length(payload: SessionLengthIn):
    if payload.session_days not in (1, 7, 30, 90):
        raise HTTPException(400, "Choose 1, 7, 30 or 90 days.")
    await update_account(session_days=payload.session_days)
    return account_public()


@api.post("/account/logout-others")
async def logout_other_devices(request: Request):
    await update_account(token_version=int(ACCOUNT.get("token_version", 1)) + 1)
    await record_login(request, "logout_all", True)
    return make_token("full")


@api.get("/account/logins")
async def recent_logins():
    rows = await db().fetch(
        "SELECT at, ip, user_agent, method, success FROM login_events ORDER BY at DESC LIMIT 25"
    )
    return [row_dict(r) for r in rows]


def allowed_origin(origin: str) -> bool:
    origin = (origin or "").rstrip("/")
    return bool(origin) and (origin in CORS_ORIGINS or bool(CORS_ORIGIN_REGEX and re.fullmatch(CORS_ORIGIN_REGEX, origin)))


def frontend_base(request: Request) -> Optional[str]:
    if FRONTEND_URL:
        return FRONTEND_URL
    origin = request.headers.get("origin", "")
    return origin.rstrip("/") if allowed_origin(origin) else None


async def send_reset_email(to: str, name: str, link: str) -> bool:
    greeting = f"Hi {html.escape(name)}," if name else "Hi,"
    text = (
        f"{greeting.replace('&amp;', '&')}\n\nSomeone (hopefully you) asked to reset your Charm.Studio password.\n"
        f"Open this link within 30 minutes to choose a new one:\n\n{link}\n\n"
        "If you didn't ask for this, ignore this email. Your password won't change."
    )
    body_html = (
        f"<p>{greeting}</p><p>Someone (hopefully you) asked to reset your Charm.Studio password.</p>"
        f'<p><a href="{html.escape(link)}" style="background:#2D4A22;color:#fff;padding:10px 16px;'
        'border-radius:8px;text-decoration:none;display:inline-block">Choose a new password</a></p>'
        "<p>The link works for 30 minutes. If you didn't ask for this, ignore this email. "
        "Your password won't change.</p>"
    )
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
                json={"from": RESEND_FROM, "to": [to], "subject": "Reset your Charm.Studio password", "html": body_html, "text": text},
            )
    except httpx.HTTPError:
        log.exception("Could not reach Resend")
        return False
    if resp.status_code >= 300:
        log.error("Resend refused the reset email (%s): %s", resp.status_code, resp.text[:300])
        return False
    return True


@public.post("/auth/forgot")
async def forgot_password(payload: ForgotIn, request: Request):
    generic = {"ok": True, "message": "If that email matches your account, a reset link is on its way. It works for 30 minutes."}
    ip = client_ip(request)
    if len(_recent(_forgot_requests, ip, _LOGIN_WINDOW_S)) >= _FORGOT_MAX:
        raise HTTPException(429, "Too many reset requests. Try again in 15 minutes.")
    _forgot_requests.setdefault(ip, []).append(time.time())

    email = (payload.email or "").strip().lower()
    if needs_setup() or not RESEND_API_KEY or not email or email != (ACCOUNT.get("email") or "").lower():
        return generic
    base = frontend_base(request)
    if not base:
        log.error("Password reset requested but FRONTEND_URL is not set and the request origin isn't allowed.")
        return generic
    token = new_reset_token()
    await db().execute("DELETE FROM password_resets WHERE expires_at < now() OR used_at IS NOT NULL")
    await db().execute(
        "INSERT INTO password_resets (token_hash, expires_at) VALUES ($1, now() + interval '30 minutes')",
        sha256_hex(token),
    )
    sent = await send_reset_email(ACCOUNT["email"], ACCOUNT.get("name", ""), f"{base}/reset-password?token={token}")
    await record_login(request, "reset_requested", sent)
    return generic


@public.post("/auth/reset")
async def reset_password(payload: ResetIn, request: Request):
    ip = client_ip(request)
    if len(_recent(_login_failures, ip, _LOGIN_WINDOW_S)) >= _LOGIN_MAX_FAILS:
        raise HTTPException(429, "Too many attempts. Try again in 15 minutes.")
    token_hash = sha256_hex((payload.token or "").strip())
    found = await db().fetchval(
        "SELECT 1 FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()", token_hash
    )
    if not found or needs_setup():
        _login_failures.setdefault(ip, []).append(time.time())
        raise HTTPException(400, "This reset link is invalid or has expired. Request a new one.")
    check_new_password(payload.password, ACCOUNT.get("email", ""))
    await update_account(
        password_hash=hash_password(payload.password),
        password_changed_at=now_utc(),
        token_version=int(ACCOUNT.get("token_version", 1)) + 1,
    )
    await db().execute("UPDATE password_resets SET used_at = now() WHERE token_hash = $1", token_hash)
    await db().execute("DELETE FROM password_resets WHERE used_at IS NULL")
    await record_login(request, "email_reset", True)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class OrderIn(BaseModel):
    order_id: str = ""
    product_name: str = ""
    charm: str = ""
    notes: str = ""
    source: str = "manual"
    channel: str = ""


class OrderPatch(BaseModel):
    order_id: Optional[str] = None
    product_name: Optional[str] = None
    charm: Optional[str] = None
    notes: Optional[str] = None
    source: Optional[str] = None
    channel: Optional[str] = None


class BulkOrders(BaseModel):
    orders: List[OrderIn]


class ExtractIn(BaseModel):
    text: str


class TestSendIn(BaseModel):
    logical_id: str
    to: str
    text: str


def build_order(data: Dict[str, Any]) -> Dict[str, Any]:
    source = str(data.get("source") or "manual")
    if source not in SOURCES:
        source = "manual"
    return {
        "id": str(uuid.uuid4()),
        "order_id": str(data.get("order_id") or "").strip(),
        "product_name": str(data.get("product_name") or "").strip(),
        "charm": str(data.get("charm") or "").strip(),
        "notes": str(data.get("notes") or "").strip(),
        "source": source,
        "channel": str(data.get("channel") or ""),
        "created_at": now_utc(),
    }


def order_args(d: Dict[str, Any]) -> tuple:
    return (d["id"], d["order_id"], d["product_name"], d["charm"], d["notes"], d["source"], d["channel"], d["created_at"])


INSERT_ORDER_SQL = f"INSERT INTO orders ({ORDER_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)"


async def insert_order(data: Dict[str, Any]) -> Dict[str, Any]:
    doc = build_order(data)
    await db().execute(INSERT_ORDER_SQL, *order_args(doc))
    return {k: iso(v) for k, v in doc.items()}


async def load_all_orders() -> List[Dict[str, Any]]:
    rows = await db().fetch(f"SELECT {ORDER_COLUMNS} FROM orders ORDER BY created_at DESC")
    return [row_dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Orders
# ---------------------------------------------------------------------------
@public.get("/")
async def root():
    return {"app": "Charm.Studio", "ok": True}


@public.get("/health")
async def health():
    await db().fetchval("SELECT 1")
    return {"ok": True}


@api.post("/orders")
async def create_order(order: OrderIn):
    return await insert_order(order.model_dump())


@api.get("/orders")
async def list_orders(q: Optional[str] = None):
    if q and q.strip():
        like = "%" + re.sub(r"([\\%_])", r"\\\1", q.strip()) + "%"
        rows = await db().fetch(
            f"""SELECT {ORDER_COLUMNS} FROM orders
                WHERE order_id ILIKE $1 OR product_name ILIKE $1 OR charm ILIKE $1 OR notes ILIKE $1
                ORDER BY created_at DESC""",
            like,
        )
        return [row_dict(r) for r in rows]
    return await load_all_orders()


@api.get("/orders/export.csv")
async def export_orders_csv():
    orders = await load_all_orders()
    buf = io.StringIO()
    cols = ["order_id", "product_name", "charm", "notes", "source", "created_at"]
    writer = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    writer.writeheader()
    for o in orders:
        writer.writerow({c: o.get(c, "") for c in cols})
    return Response(
        content=buf.getvalue().encode("utf-8-sig"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="charm_orders.csv"'},
    )


@api.post("/orders/bulk")
async def bulk_orders(payload: BulkOrders):
    docs = [build_order(o.model_dump()) for o in payload.orders]
    docs = [d for d in docs if any(d[f] for f in ORDER_FIELDS)]
    if docs:
        async with db().acquire() as conn:
            async with conn.transaction():
                await conn.executemany(INSERT_ORDER_SQL, [order_args(d) for d in docs])
    return {"inserted": len(docs), "orders": [{k: iso(v) for k, v in d.items()} for d in docs]}


@api.patch("/orders/{oid}")
async def update_order(oid: str, patch: OrderPatch):
    changes = {k: (v.strip() if isinstance(v, str) else v) for k, v in patch.model_dump().items() if v is not None}
    if not changes:
        raise HTTPException(400, "No fields to update")
    cols = list(changes.keys())  # keys come from the pydantic model, never from user input
    sets = ", ".join(f"{c} = ${i + 2}" for i, c in enumerate(cols))
    row = await db().fetchrow(
        f"UPDATE orders SET {sets} WHERE id = $1 RETURNING {ORDER_COLUMNS}", oid, *[changes[c] for c in cols]
    )
    if not row:
        raise HTTPException(404, "Order not found")
    return row_dict(row)


@api.delete("/orders/{oid}")
async def delete_order(oid: str):
    res = await db().execute("DELETE FROM orders WHERE id = $1", oid)
    if res.endswith(" 0"):
        raise HTTPException(404, "Order not found")
    return {"deleted": 1}


@api.delete("/orders")
async def delete_all_orders():
    res = await db().execute("DELETE FROM orders")
    return {"deleted": int(res.split()[-1])}


@api.get("/stats")
async def stats():
    today_start = now_utc().replace(hour=0, minute=0, second=0, microsecond=0)
    async with db().acquire() as conn:
        total = await conn.fetchval("SELECT count(*) FROM orders")
        today = await conn.fetchval("SELECT count(*) FROM orders WHERE created_at >= $1", today_start)
        rows = await conn.fetch("SELECT source, count(*) AS n FROM orders GROUP BY source")
    by_source = {s: 0 for s in SOURCES}
    for r in rows:
        by_source[r["source"] or "manual"] = r["n"]
    return {
        "total_orders": total,
        "today_orders": today,
        "whatsapp_orders": by_source.get("whatsapp", 0),
        "by_source": by_source,
    }


# ---------------------------------------------------------------------------
# AI helpers
#
# AI_PROVIDER=anthropic (default): Claude via the Anthropic API.
# AI_PROVIDER=ollama: Ollama's Anthropic-compatible /v1/messages endpoint, either
#   Ollama Cloud (OLLAMA_BASE_URL=https://ollama.com, needs OLLAMA_API_KEY) or a
#   local/self-hosted server (e.g. http://localhost:11434, no key needed).
# Both go through the Anthropic SDK; only the base URL, auth and model change.
# ---------------------------------------------------------------------------
AI_PROVIDER = os.environ.get("AI_PROVIDER", "anthropic").strip().lower() or "anthropic"
if AI_PROVIDER not in ("anthropic", "ollama"):
    raise RuntimeError(f"AI_PROVIDER must be 'anthropic' or 'ollama', got '{AI_PROVIDER}'")

ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "").strip() or "claude-sonnet-5-5"
OLLAMA_BASE_URL = (os.environ.get("OLLAMA_BASE_URL", "").strip() or "https://ollama.com").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "").strip()
AI_MODEL = OLLAMA_MODEL if AI_PROVIDER == "ollama" else ANTHROPIC_MODEL

_ai_client: Optional[AsyncAnthropic] = None

EXTRACT_SYSTEM = (
    "You extract customised-charm orders from WhatsApp chat text. Return ONLY a JSON array of "
    "objects with keys order_id, product_name (name to print on product), charm, notes. Use empty "
    "strings for unknown fields. No prose."
)

BOT_EXTRACT_SYSTEM = (
    "You extract order details from a single WhatsApp message sent by a customer ordering a "
    "customised charm. Return ONLY a JSON object with keys order_id, product_name (name to print "
    "on product), charm, notes. Use empty strings for anything not stated. No prose."
)


def get_ai() -> AsyncAnthropic:
    global _ai_client
    if _ai_client is not None:
        return _ai_client
    if AI_PROVIDER == "ollama":
        if not OLLAMA_MODEL:
            raise HTTPException(500, "OLLAMA_MODEL is not set (e.g. a model name listed on ollama.com)")
        key = os.environ.get("OLLAMA_API_KEY", "").strip()
        if not key and "ollama.com" in OLLAMA_BASE_URL:
            raise HTTPException(500, "OLLAMA_API_KEY is not set")
        _ai_client = AsyncAnthropic(
            base_url=OLLAMA_BASE_URL,
            # Ollama wants "Authorization: Bearer <key>". Passing an explicit credential also stops
            # the SDK from picking up ANTHROPIC_API_KEY, so that key is never sent to Ollama.
            auth_token=key or "ollama",
            default_headers={"anthropic-version": "2023-06-01"},
        )
    else:
        key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
        if not key:
            raise HTTPException(500, "ANTHROPIC_API_KEY is not set")
        _ai_client = AsyncAnthropic(api_key=key)
    return _ai_client


def _response_text(resp: Any) -> str:
    return "".join(getattr(b, "text", "") or "" for b in resp.content if getattr(b, "type", "") == "text")


async def claude_text(system: str, user: str, max_tokens: int = 16000, effort: Optional[str] = None) -> str:
    """Send one system+user prompt to the configured AI provider and return the reply text."""
    client = get_ai()
    if AI_PROVIDER == "ollama":
        # Plain Messages call: Ollama does not support Anthropic-only extras (fallbacks, effort).
        resp = await client.messages.create(
            model=AI_MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return _response_text(resp)

    # Sent via extra_body so the call works regardless of which SDK release exposes these as named params.
    # "fallbacks": if the model declines, the API retries on a suitable fallback model server-side.
    extra: Dict[str, Any] = {"fallbacks": "default"}
    if effort:
        extra["output_config"] = {"effort": effort}
    resp = await client.beta.messages.create(
        model=AI_MODEL,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
        betas=["server-side-fallback-2026-07-01"],
        extra_body=extra,
    )
    if resp.stop_reason == "refusal":
        raise RuntimeError("Claude declined to process this text")
    return _response_text(resp)


def _strip_fences(text: str) -> str:
    t = text.strip()
    t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    return t.strip()


def _clean_row(row: Any) -> Optional[Dict[str, str]]:
    if not isinstance(row, dict):
        return None
    out = {f: str(row.get(f) or "").strip() for f in ORDER_FIELDS}
    return out if any(out.values()) else None


def parse_json_any(text: str) -> Any:
    t = _strip_fences(text)
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    for open_c, close_c in (("[", "]"), ("{", "}")):
        s, e = t.find(open_c), t.rfind(close_c)
        if s != -1 and e > s:
            try:
                return json.loads(t[s : e + 1])
            except json.JSONDecodeError:
                continue
    return None


def parse_orders(text: str) -> List[Dict[str, str]]:
    data = parse_json_any(text)
    if isinstance(data, dict):
        data = data.get("orders", [data])
    if not isinstance(data, list):
        return []
    return [r for r in (_clean_row(x) for x in data) if r]


def chunk_text(text: str, size: int = 15000) -> List[str]:
    chunks, cur, cur_len = [], [], 0
    for line in text.splitlines(keepends=True):
        if cur and cur_len + len(line) > size:
            chunks.append("".join(cur))
            cur, cur_len = [], 0
        cur.append(line)
        cur_len += len(line)
    if cur:
        chunks.append("".join(cur))
    return [c for c in chunks if c.strip()]


def dedupe_orders(rows: List[Dict[str, str]]):
    merged: List[Dict[str, str]] = []
    index: Dict[str, int] = {}
    dupes = 0
    for r in rows:
        key = norm_id(r.get("order_id", ""))
        if key and key in index:
            dupes += 1
            target = merged[index[key]]
            for f in ORDER_FIELDS:
                if not target.get(f) and r.get(f):
                    target[f] = r[f]
            continue
        if key:
            index[key] = len(merged)
        merged.append(dict(r))
    return merged, dupes


# ---------------------------------------------------------------------------
# AI extraction
# ---------------------------------------------------------------------------
@api.post("/extract")
async def extract(payload: ExtractIn):
    if not payload.text.strip():
        raise HTTPException(400, "Text is empty")
    try:
        raw = await claude_text(EXTRACT_SYSTEM, payload.text)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("Extraction failed")
        raise HTTPException(502, f"AI extraction failed: {e}")
    return {"orders": parse_orders(raw)}


@api.post("/extract/bulk-file")
async def extract_bulk_file(file: UploadFile = File(...)):
    content = (await file.read()).decode("utf-8", errors="ignore")
    chunks = chunk_text(content)
    if not chunks:
        raise HTTPException(400, "File is empty")
    sem = asyncio.Semaphore(3)

    async def run(chunk: str) -> List[Dict[str, str]]:
        async with sem:
            return parse_orders(await claude_text(EXTRACT_SYSTEM, chunk))

    try:
        results = await asyncio.gather(*(run(c) for c in chunks))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("Bulk extraction failed")
        raise HTTPException(502, f"AI extraction failed: {e}")
    all_rows = [r for res in results for r in res]
    orders, dupes = dedupe_orders(all_rows)
    return {"orders": orders, "chunks_processed": len(chunks), "duplicates_removed": dupes}


# ---------------------------------------------------------------------------
# PDF Label Studio
# ---------------------------------------------------------------------------
ID_PATTERNS = [
    re.compile(r"\b\d{10,}[_-]\d{1,}\b"),  # Meesho
    re.compile(r"\bOD\d{15,}\b", re.IGNORECASE),  # Flipkart
    re.compile(r"\b\d{13,}\b"),  # fallback long numeric
]


def norm_id(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", s or "").upper()


def ids_match(a: str, b: str) -> bool:
    a, b = norm_id(a), norm_id(b)
    if not a or not b:
        return False
    if a == b:
        return True
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    if len(short) < 8:
        return False
    return any(short[i : i + 8] in long_ for i in range(len(short) - 7))


def detect_ids(text: str) -> List[str]:
    found: List[str] = []
    for pattern in ID_PATTERNS:
        for m in pattern.findall(text):
            # skip fallback hits that are just part of an already-detected id
            if m in found or any(m in f for f in found):
                continue
            found.append(m)
    return found


def match_orders(detected: List[str], orders: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    exact, fuzzy, seen = [], [], set()
    for did in detected:
        nd = norm_id(did)
        for o in orders:
            if o["id"] in seen or not ids_match(did, o.get("order_id", "")):
                continue
            seen.add(o["id"])
            (exact if norm_id(o.get("order_id", "")) == nd else fuzzy).append(o)
    return exact + fuzzy


def open_pdf(data: bytes) -> fitz.Document:
    try:
        return fitz.open(stream=data, filetype="pdf")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Could not open PDF: {e}")


@api.post("/pdf/analyze")
async def pdf_analyze(file: UploadFile = File(...)):
    data = await file.read()
    doc = open_pdf(data)
    orders = await load_all_orders()
    pages = []
    summary = {"total_pages": doc.page_count, "matched": 0, "not_found": 0, "no_id": 0}
    try:
        for i, page in enumerate(doc):
            detected = detect_ids(page.get_text())
            matches = match_orders(detected, orders) if detected else []
            status = "matched" if matches else ("not_found" if detected else "no_id")
            summary[status] += 1
            pix = page.get_pixmap(matrix=fitz.Matrix(0.5, 0.5))
            pages.append(
                {
                    "page": i + 1,
                    "detected_ids": detected,
                    "matches": matches,
                    "status": status,
                    "thumbnail": "data:image/png;base64," + base64.b64encode(pix.tobytes("png")).decode(),
                }
            )
    finally:
        doc.close()
    return {"filename": file.filename, "summary": summary, "pages": pages}


GREEN = (0x2D / 255, 0x4A / 255, 0x22 / 255)
RED = (0xC0 / 255, 0x39 / 255, 0x2B / 255)
INK = (0.1, 0.1, 0.1)
WHITE = (1, 1, 1)


ELLIPSIS = "..."  # base-14 Helvetica cannot render U+2026


def truncate(text: str, limit: int = 30) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + ELLIPSIS


def fit_width(text: str, width: float, font: str, size: float) -> str:
    if fitz.get_text_length(text, fontname=font, fontsize=size) <= width:
        return text
    while text and fitz.get_text_length(text + ELLIPSIS, fontname=font, fontsize=size) > width:
        text = text[:-1]
    return text.rstrip() + ELLIPSIS


def draw_sticker(page: fitz.Page, position: str, header: str, lines: List[str], color, font_size: float):
    """Compact corner sticker, kept small so it never covers the barcode."""
    width, margin, pad = 180.0, 14.0, 4.0
    header_h = font_size + 6
    line_h = font_size + 3
    height = header_h + pad * 2 + line_h * len(lines) - 3
    r = page.rect
    x0 = r.x1 - margin - width if "right" in position else r.x0 + margin
    y0 = r.y1 - margin - height if "bottom" in position else r.y0 + margin
    box = fitz.Rect(x0, y0, x0 + width, y0 + height)

    page.draw_rect(box, color=color, fill=WHITE, width=0.8, overlay=True)
    page.draw_rect(fitz.Rect(x0, y0, x0 + width, y0 + header_h), color=color, fill=color, width=0.8, overlay=True)
    page.insert_text(
        (x0 + pad, y0 + header_h - 3.5), header, fontname="hebo", fontsize=font_size, color=WHITE, overlay=True
    )
    y = y0 + header_h + pad + font_size - 1
    for line in lines:
        page.insert_text(
            (x0 + pad, y),
            fit_width(line, width - pad * 2, "helv", font_size),
            fontname="helv",
            fontsize=font_size,
            color=INK,
            overlay=True,
        )
        y += line_h


@api.post("/pdf/annotate")
async def pdf_annotate(
    file: UploadFile = File(...),
    position: str = Form("bottom-right"),
    skip_unmatched: bool = Form(False),
    font_size: float = Form(8),
    overrides: Optional[str] = Form(None),
):
    if position not in ("bottom-right", "bottom-left", "top-right", "top-left"):
        position = "bottom-right"
    font_size = max(5.0, min(float(font_size), 14.0))
    try:
        raw_overrides = json.loads(overrides) if overrides else {}
        override_map: Dict[str, str] = {str(k): str(v) for k, v in raw_overrides.items() if v}
    except (json.JSONDecodeError, AttributeError):
        raise HTTPException(400, "overrides must be a JSON object of page -> order id")

    data = await file.read()
    doc = open_pdf(data)
    orders = await load_all_orders()
    by_uuid = {o["id"]: o for o in orders}
    by_order_id = {norm_id(o.get("order_id", "")): o for o in reversed(orders) if o.get("order_id")}

    matched = not_found = 0
    try:
        for i, page in enumerate(doc):
            pno = str(i + 1)
            detected = detect_ids(page.get_text())
            order = None
            if pno in override_map:
                ov = override_map[pno]
                order = by_uuid.get(ov) or by_order_id.get(norm_id(ov))
            if order is None and detected:
                found = match_orders(detected, orders)
                order = found[0] if found else None

            if order:
                matched += 1
                draw_sticker(
                    page,
                    position,
                    "CUSTOMISATION",
                    [
                        f"Name: {truncate(order.get('product_name') or '-')}",
                        f"Charm: {truncate(order.get('charm') or '-')}",
                        f"Notes: {truncate(order.get('notes') or '-')}",
                    ],
                    GREEN,
                    font_size,
                )
            else:
                not_found += 1
                if not skip_unmatched:
                    detail = f"ID: {truncate(detected[0], 34)}" if detected else "No order ID detected"
                    draw_sticker(page, position, "ORDER NOT FOUND", [detail], RED, font_size)
        out = doc.tobytes(garbage=3, deflate=True)
    finally:
        doc.close()

    stem = Path(file.filename or "labels.pdf").stem
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", stem) or "labels"
    return Response(
        content=out,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="annotated_{safe}.pdf"',
            "X-Matched-Pages": str(matched),
            "X-Not-Found-Pages": str(not_found),
        },
    )


# ---------------------------------------------------------------------------
# WhatsApp bot
# ---------------------------------------------------------------------------
STEP_KEYS = ["order_id", "product_name", "charm", "notes"]
RESET_WORDS = {"restart", "reset", "hi", "hello", "start"}
SKIP_WORDS = {"none", "no", "skip", "-", "nil", "na", "n/a"}


def bot_text(key: str) -> str:
    """A bot message from Settings (falls back to the default wording)."""
    return (SETTINGS.get("bot") or {}).get(key) or DEFAULT_SETTINGS["bot"][key]


def bot_question(step: int) -> str:
    return bot_text(f"ask_{STEP_KEYS[step]}")


def fill_template(text: str, values: Dict[str, str]) -> str:
    """Replace {placeholders} we know about; leave any other braces untouched."""
    for key, value in values.items():
        text = text.replace("{" + key + "}", value)
    return text


def step_filled(fields: Dict[str, str], key: str) -> bool:
    if key not in fields:
        return False
    return key == "notes" or bool(fields[key])  # notes may be answered as empty


def next_step(fields: Dict[str, str]) -> int:
    for i, k in enumerate(STEP_KEYS):
        if not step_filled(fields, k):
            return i
    return len(STEP_KEYS)


async def send_wa(cfg: Dict[str, Any], to: str, text: str) -> httpx.Response:
    url = f"https://graph.facebook.com/{WA_GRAPH_VERSION}/{cfg['phone_id']}/messages"
    body = {"messaging_product": "whatsapp", "to": to, "type": "text", "text": {"body": text}}
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(url, json=body, headers={"Authorization": f"Bearer {cfg['token']}"})
    if resp.status_code >= 300:
        log.warning("WhatsApp send failed (%s): %s", resp.status_code, resp.text[:500])
    return resp


async def ai_extract_message(text: str) -> Dict[str, str]:
    try:
        raw = await claude_text(BOT_EXTRACT_SYSTEM, text, max_tokens=2000, effort="low")
    except Exception:  # noqa: BLE001
        log.exception("Bot AI extraction failed")
        return {}
    data = parse_json_any(raw)
    if isinstance(data, list):
        data = data[0] if data else {}
    row = _clean_row(data) or {}
    return {k: v for k, v in row.items() if v}


UPSERT_CONV_SQL = """
INSERT INTO wa_conversations (business_number_id, customer_phone, step, fields, started_at, updated_at)
VALUES ($1, $2, $3, $4, now(), now())
ON CONFLICT (business_number_id, customer_phone)
DO UPDATE SET step = EXCLUDED.step, fields = EXCLUDED.fields, updated_at = now()
"""


async def handle_bot_message(cfg: Dict[str, Any], customer: str, text: str):
    biz = cfg["logical_id"]
    conv = await db().fetchrow(
        "SELECT step, fields FROM wa_conversations WHERE business_number_id = $1 AND customer_phone = $2",
        biz,
        customer,
    )
    cleaned = text.strip()
    lowered = cleaned.lower().strip(" !.")

    if lowered in RESET_WORDS:
        await db().execute(UPSERT_CONV_SQL, biz, customer, 0, {})
        await send_wa(cfg, customer, bot_question(0))
        return

    is_new = conv is None
    fields: Dict[str, str] = dict(conv["fields"] or {}) if conv else {}
    step = next_step(fields)

    if len(cleaned.split()) >= 6:
        extracted = await ai_extract_message(cleaned)
        for k, v in extracted.items():
            if not fields.get(k):
                fields[k] = v
        if not extracted and not is_new:
            fields[STEP_KEYS[step]] = cleaned
    elif is_new and not re.search(r"\d", cleaned):
        pass  # first contact with a short non-ID message: just greet below
    else:
        current = STEP_KEYS[step]
        if current == "notes" and lowered in SKIP_WORDS:
            fields["notes"] = ""
        else:
            fields[current] = cleaned

    step = next_step(fields)
    if step >= len(STEP_KEYS):
        order = await insert_order(
            {
                "order_id": fields.get("order_id") or f"wa-{uuid.uuid4().hex[:8]}",
                "product_name": fields.get("product_name", ""),
                "charm": fields.get("charm", ""),
                "notes": fields.get("notes", ""),
                "source": "whatsapp",
                "channel": biz,
            }
        )
        await db().execute(
            "DELETE FROM wa_conversations WHERE business_number_id = $1 AND customer_phone = $2", biz, customer
        )
        summary = fill_template(
            bot_text("thank_you"),
            {
                "shop_name": (SETTINGS.get("shop") or {}).get("shop_name", ""),
                "order_id": order["order_id"],
                "name": order["product_name"] or "-",
                "charm": order["charm"] or "-",
                "notes": order["notes"] or "-",
            },
        )
        await send_wa(cfg, customer, summary)
        return

    await db().execute(UPSERT_CONV_SQL, biz, customer, step, fields)
    await send_wa(cfg, customer, bot_question(step))


async def process_webhook(body: Dict[str, Any]):
    try:
        for entry in body.get("entry", []) or []:
            for change in entry.get("changes", []) or []:
                value = change.get("value", {}) or {}
                phone_id = (value.get("metadata") or {}).get("phone_number_id")
                cfg = WA_NUMBERS.get(str(phone_id)) if phone_id else None
                if not cfg:
                    continue  # unknown or paused number: ignore
                for msg in value.get("messages", []) or []:
                    if msg.get("type") != "text" or not msg.get("id"):
                        continue
                    fresh = await db().fetchval(
                        "INSERT INTO wa_events (message_id, received_at) VALUES ($1, now()) "
                        "ON CONFLICT (message_id) DO NOTHING RETURNING message_id",
                        msg["id"],
                    )
                    if not fresh:
                        continue  # duplicate delivery from Meta
                    try:
                        await handle_bot_message(cfg, msg.get("from", ""), (msg.get("text") or {}).get("body", ""))
                    except Exception:  # noqa: BLE001
                        log.exception("Bot failed for message %s", msg["id"])
    except Exception:  # noqa: BLE001
        log.exception("Webhook processing failed")


def all_verify_tokens() -> set:
    tokens = {c["verify"] for c in WA_ALL if c.get("verify")}
    if WA_VERIFY_TOKEN:
        tokens.add(WA_VERIFY_TOKEN)
    return tokens


@public.get("/wa/webhook")
async def wa_verify(request: Request):
    qp = request.query_params
    if qp.get("hub.mode") == "subscribe" and qp.get("hub.verify_token") in all_verify_tokens():
        return PlainTextResponse(qp.get("hub.challenge", ""))
    return PlainTextResponse("Forbidden", status_code=403)


@public.post("/wa/webhook")
async def wa_webhook(request: Request, background: BackgroundTasks):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    if isinstance(body, dict):
        background.add_task(process_webhook, body)
    return {"status": "received"}


def public_base_url(request: Request) -> str:
    override = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
    if override:
        return override
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}"


@api.get("/wa/status")
async def wa_status(request: Request):
    async with db().acquire() as conn:
        active = await conn.fetchval("SELECT count(*) FROM wa_conversations")
        wa_orders = await conn.fetchval("SELECT count(*) FROM orders WHERE source = 'whatsapp'")
    return {
        "configured": bool(WA_NUMBERS),
        "verify_token_set": bool(all_verify_tokens()),
        "numbers_count": len(WA_NUMBERS),
        "numbers_saved": len(WA_ALL),
        "callback_url": f"{public_base_url(request)}/api/wa/webhook",
        "active_conversations": active,
        "whatsapp_orders": wa_orders,
        "graph_version": WA_GRAPH_VERSION,
    }


@api.get("/wa/conversations")
async def wa_conversations():
    rows = await db().fetch(
        "SELECT business_number_id, customer_phone, step, fields, started_at, updated_at "
        "FROM wa_conversations ORDER BY updated_at DESC LIMIT 50"
    )
    return [row_dict(r) for r in rows]


@api.post("/wa/test-send")
async def wa_test_send(payload: TestSendIn):
    cfg = next((c for c in WA_NUMBERS.values() if c["logical_id"] == payload.logical_id), None)
    if not cfg:
        raise HTTPException(404, f"'{payload.logical_id}' isn't an active WhatsApp number.")
    to = re.sub(r"[^\d]", "", payload.to)
    if not to or not payload.text.strip():
        raise HTTPException(400, "Recipient and text are required")
    try:
        resp = await send_wa(cfg, to, payload.text)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Could not reach WhatsApp API: {e}")
    try:
        meta = resp.json()
    except ValueError:
        meta = {"raw": resp.text}
    if resp.status_code >= 300:
        msg = (meta.get("error") or {}).get("message") if isinstance(meta, dict) else None
        raise HTTPException(502, msg or f"WhatsApp API error {resp.status_code}")
    return {"ok": True, "response": meta}


# ---------------------------------------------------------------------------
# WhatsApp numbers (Settings). Tokens are encrypted at rest and never returned.
# ---------------------------------------------------------------------------
LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$")
META_CHECK_FAILED = 424  # tells the frontend it may offer "Save anyway"


class WaNumberIn(BaseModel):
    label: str
    phone_id: str
    token: str
    display: str = ""
    verify_token: str = ""
    skip_check: bool = False


class WaNumberPatch(BaseModel):
    label: Optional[str] = None
    phone_id: Optional[str] = None
    token: Optional[str] = None  # empty/None keeps the saved token
    display: Optional[str] = None
    verify_token: Optional[str] = None  # None keeps, "" clears
    active: Optional[bool] = None
    skip_check: bool = False


def wa_public(cfg: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": cfg["id"],
        "label": cfg["label"],
        "logical_id": cfg["logical_id"],
        "display": cfg["display"],
        "phone_id": cfg["phone_id"],
        "token_hint": f"••••{cfg['token_last4']}" if cfg.get("token_last4") else "",
        "token_ok": cfg["token"] is not None,
        "active": cfg["active"],
        "has_verify_token": bool(cfg.get("verify")),
        "created_at": cfg["created_at"],
    }


def clean_label(label: str) -> str:
    label = " ".join((label or "").split())
    if not LABEL_RE.match(label):
        raise HTTPException(400, "Name: 1-40 letters, numbers, spaces, - or _ (start with a letter or number).")
    return label


def clean_phone_id(phone_id: str) -> str:
    phone_id = (phone_id or "").strip()
    if not re.fullmatch(r"\d{5,30}", phone_id):
        raise HTTPException(400, "Phone Number ID should be the long number from Meta's API Setup page (digits only).")
    return phone_id


def clean_wa_token(token: str) -> str:
    token = (token or "").strip()
    if len(token) < 20 or " " in token:
        raise HTTPException(400, "That access token looks incomplete. Copy the whole token from Meta.")
    return token


async def meta_check(phone_id: str, token: str) -> Dict[str, Any]:
    """Ask Meta about this number. Raises HTTPException(424) with Meta's message if it's rejected."""
    url = f"https://graph.facebook.com/{WA_GRAPH_VERSION}/{phone_id}"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                url,
                params={"fields": "display_phone_number,verified_name,quality_rating"},
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError:
        raise HTTPException(META_CHECK_FAILED, "Couldn't reach Meta to check this number. Try again, or save anyway.")
    data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
    if resp.status_code >= 300:
        msg = (data.get("error") or {}).get("message") if isinstance(data, dict) else None
        raise HTTPException(META_CHECK_FAILED, f"Meta rejected these details: {msg or resp.status_code}")
    return data if isinstance(data, dict) else {}


def find_number(number_id: str) -> Dict[str, Any]:
    cfg = next((c for c in WA_ALL if c["id"] == number_id), None)
    if not cfg:
        raise HTTPException(404, "That WhatsApp number no longer exists.")
    return cfg


def ensure_unique(label: Optional[str] = None, phone_id: Optional[str] = None, exclude: str = "") -> None:
    for c in WA_ALL:
        if c["id"] == exclude:
            continue
        if label and c["label"].casefold() == label.casefold():
            raise HTTPException(409, f"You already have a number called '{c['label']}'.")
        if phone_id and c["phone_id"] == phone_id:
            raise HTTPException(409, f"This Phone Number ID is already saved as '{c['label']}'.")


@api.get("/wa/numbers")
async def list_wa_numbers():
    return [wa_public(c) for c in WA_ALL]


@api.post("/wa/numbers", status_code=201)
async def add_wa_number(payload: WaNumberIn):
    if not AUTH_SECRET:
        raise HTTPException(503, "Set AUTH_SECRET on the server before saving WhatsApp numbers.")
    label, phone_id, token = clean_label(payload.label), clean_phone_id(payload.phone_id), clean_wa_token(payload.token)
    ensure_unique(label, phone_id)
    display = " ".join(payload.display.split())[:40]
    if not payload.skip_check:
        info = await meta_check(phone_id, token)
        display = display or info.get("display_phone_number", "")
    number_id = str(uuid.uuid4())
    verify = payload.verify_token.strip()
    await db().execute(
        "INSERT INTO wa_numbers (id, label, display, phone_id, token_enc, token_last4, verify_token_enc) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7)",
        number_id,
        label,
        display,
        phone_id,
        secret_box.encrypt(token),
        token[-4:],
        secret_box.encrypt(verify) if verify else "",
    )
    await load_wa_numbers()
    return wa_public(find_number(number_id))


@api.patch("/wa/numbers/{number_id}")
async def update_wa_number(number_id: str, payload: WaNumberPatch):
    cfg = find_number(number_id)
    changes: Dict[str, Any] = {}
    label = clean_label(payload.label) if payload.label is not None else None
    phone_id = clean_phone_id(payload.phone_id) if payload.phone_id is not None else None
    token = clean_wa_token(payload.token) if payload.token else None
    ensure_unique(
        label if label and label != cfg["label"] else None,
        phone_id if phone_id and phone_id != cfg["phone_id"] else None,
        exclude=number_id,
    )
    if (token or (phone_id and phone_id != cfg["phone_id"])) and not payload.skip_check:
        check_token = token or cfg["token"]
        if check_token:
            await meta_check(phone_id or cfg["phone_id"], check_token)
    if label is not None:
        changes["label"] = label
    if phone_id is not None:
        changes["phone_id"] = phone_id
    if token:
        changes["token_enc"] = secret_box.encrypt(token)
        changes["token_last4"] = token[-4:]
    if payload.display is not None:
        changes["display"] = " ".join(payload.display.split())[:40]
    if payload.verify_token is not None:
        v = payload.verify_token.strip()
        changes["verify_token_enc"] = secret_box.encrypt(v) if v else ""
    if payload.active is not None:
        changes["active"] = payload.active
    if changes:
        cols = list(changes)  # fixed names from this function
        sets = ", ".join(f"{c} = ${i + 2}" for i, c in enumerate(cols))
        async with db().acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    f"UPDATE wa_numbers SET {sets}, updated_at = now() WHERE id = $1",
                    number_id,
                    *[changes[c] for c in cols],
                )
                if label and label != cfg["label"]:
                    # keep in-progress bot chats attached to the renamed number
                    await conn.execute(
                        "UPDATE wa_conversations SET business_number_id = $1 WHERE business_number_id = $2",
                        label,
                        cfg["label"],
                    )
        await load_wa_numbers()
    return wa_public(find_number(number_id))


@api.delete("/wa/numbers/{number_id}")
async def delete_wa_number(number_id: str):
    cfg = find_number(number_id)
    async with db().acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM wa_numbers WHERE id = $1", number_id)
            await conn.execute("DELETE FROM wa_conversations WHERE business_number_id = $1", cfg["label"])
    await load_wa_numbers()
    return {"deleted": 1}


@api.post("/wa/numbers/{number_id}/check")
async def check_wa_number(number_id: str):
    cfg = find_number(number_id)
    if cfg["token"] is None:
        raise HTTPException(400, "The saved token can't be read any more. Edit the number and paste the token again.")
    info = await meta_check(cfg["phone_id"], cfg["token"])
    if not cfg["display"] and info.get("display_phone_number"):
        await db().execute(
            "UPDATE wa_numbers SET display = $2, updated_at = now() WHERE id = $1",
            number_id,
            info["display_phone_number"][:40],
        )
        await load_wa_numbers()
    return {
        "ok": True,
        "display_phone_number": info.get("display_phone_number", ""),
        "verified_name": info.get("verified_name", ""),
        "quality_rating": info.get("quality_rating", ""),
    }


# ---------------------------------------------------------------------------
# Settings: shop profile, bot wording, label defaults, system status
# ---------------------------------------------------------------------------
class ShopSettingsIn(BaseModel):
    shop_name: str = Field("", max_length=60)


class BotSettingsIn(BaseModel):
    ask_order_id: str = Field(..., min_length=1, max_length=1000)
    ask_product_name: str = Field(..., min_length=1, max_length=1000)
    ask_charm: str = Field(..., min_length=1, max_length=1000)
    ask_notes: str = Field(..., min_length=1, max_length=1000)
    thank_you: str = Field(..., min_length=1, max_length=1500)


class LabelSettingsIn(BaseModel):
    position: Literal["bottom-right", "bottom-left", "top-right", "top-left"] = "bottom-right"
    font_size: float = Field(8, ge=5, le=14)
    skip_unmatched: bool = False


@api.get("/settings")
async def get_settings():
    return {**SETTINGS, "defaults": DEFAULT_SETTINGS}


async def _save_section(section: str, value: Dict[str, Any]):
    await save_setting(section, value)
    await load_settings()
    return {**SETTINGS, "defaults": DEFAULT_SETTINGS}


@api.put("/settings/shop")
async def save_shop_settings(payload: ShopSettingsIn):
    return await _save_section("shop", {"shop_name": " ".join(payload.shop_name.split())})


@api.put("/settings/bot")
async def save_bot_settings(payload: BotSettingsIn):
    return await _save_section("bot", {k: v.strip() for k, v in payload.model_dump().items()})


@api.put("/settings/labels")
async def save_label_settings(payload: LabelSettingsIn):
    return await _save_section("labels", payload.model_dump())


@api.get("/system/status")
async def system_status(request: Request):
    if AI_PROVIDER == "ollama":
        ai_ready = bool(OLLAMA_MODEL) and (bool(os.environ.get("OLLAMA_API_KEY", "").strip()) or "ollama.com" not in OLLAMA_BASE_URL)
    else:
        ai_ready = bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())
    return {
        "ai": {"provider": AI_PROVIDER, "model": AI_MODEL or "", "ready": ai_ready},
        "email_reset": {
            "configured": bool(RESEND_API_KEY),
            "sender": RESEND_FROM,
            "frontend_url_set": bool(FRONTEND_URL),
            "account_email": ACCOUNT.get("email", ""),
        },
        "reset_override_active": bool(RESET_PASSWORD),
        "whatsapp": {
            "verify_token_set": bool(all_verify_tokens()),
            "callback_url": f"{public_base_url(request)}/api/wa/webhook",
            "saved": len(WA_ALL),
            "active": len(WA_NUMBERS),
            "unreadable_tokens": sum(1 for c in WA_ALL if c["token"] is None),
        },
    }


# ---------------------------------------------------------------------------
app.include_router(public)
app.include_router(session)
app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_origin_regex=CORS_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Matched-Pages", "X-Not-Found-Pages", "Content-Disposition"],
)
