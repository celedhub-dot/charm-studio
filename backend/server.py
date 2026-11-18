"""Charm.Studio backend.

FastAPI + asyncpg (Supabase Postgres) + PyMuPDF + Anthropic SDK.
All routes are mounted under /api.
"""
import asyncio
import base64
import csv
import hashlib
import hmac
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
from typing import Any, Dict, List, Optional

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
from pydantic import BaseModel
from starlette.middleware.cors import CORSMiddleware

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
# WhatsApp number config (multi-number)
# ---------------------------------------------------------------------------
WA_GRAPH_VERSION = os.environ.get("WA_GRAPH_VERSION", "v20.0")
WA_VERIFY_TOKEN = os.environ.get("WA_VERIFY_TOKEN", "").strip()


def load_wa_numbers() -> Dict[str, Dict[str, str]]:
    """Return a map phone_number_id -> config for each logical id in WA_NUMBERS."""
    numbers: Dict[str, Dict[str, str]] = {}
    for logical_id in [x.strip() for x in os.environ.get("WA_NUMBERS", "").split(",") if x.strip()]:
        key = logical_id.upper()
        phone_id = os.environ.get(f"WA_{key}_PHONE_ID", "").strip()
        token = os.environ.get(f"WA_{key}_TOKEN", "").strip()
        if not phone_id or not token:
            log.warning("WhatsApp number '%s' skipped: missing PHONE_ID or TOKEN", logical_id)
            continue
        numbers[phone_id] = {
            "logical_id": logical_id,
            "phone_id": phone_id,
            "token": token,
            "display": os.environ.get(f"WA_{key}_DISPLAY", "").strip(),
            "verify": os.environ.get(f"WA_{key}_VERIFY", "").strip(),
        }
    return numbers


WA_NUMBERS = load_wa_numbers()


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(_: FastAPI):
    global pool
    # statement_cache_size=0 keeps asyncpg compatible with Supabase's transaction pooler (pgbouncer).
    pool = await asyncpg.create_pool(
        DATABASE_URL,
        min_size=1,
        max_size=int(os.environ.get("DB_POOL_SIZE", "5")),
        statement_cache_size=0,
        init=_init_conn,
        command_timeout=60,
    )
    async with pool.acquire() as conn:
        await conn.execute(SCHEMA_SQL)
    log.info("Charm.Studio ready. WhatsApp numbers configured: %d", len(WA_NUMBERS))
    yield
    await pool.close()


app = FastAPI(title="Charm.Studio API", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Authentication
#
# Single-seller app: one admin password (ADMIN_PASSWORD). POST /api/auth/login
# exchanges it for a signed, expiring bearer token; every other /api route needs
# "Authorization: Bearer <token>" except the public ones (health, WhatsApp webhook).
#
# Tokens are HMAC-SHA256 signed with a key derived from AUTH_SECRET *and*
# ADMIN_PASSWORD, so changing either one logs every device out.
# ---------------------------------------------------------------------------
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
AUTH_SECRET = os.environ.get("AUTH_SECRET", "")
AUTH_TOKEN_DAYS = float(os.environ.get("AUTH_TOKEN_DAYS", "30"))
AUTH_CONFIGURED = (
    len(ADMIN_PASSWORD) >= 8
    and len(AUTH_SECRET) >= 32
    # refuse the unedited placeholders from .env.example (the repo is public)
    and not ADMIN_PASSWORD.startswith("<")
    and not AUTH_SECRET.startswith("<")
)
if not AUTH_CONFIGURED:
    log.error(
        "Auth is not configured: set ADMIN_PASSWORD (8+ chars) and AUTH_SECRET (32+ random chars). "
        "All protected API routes will return 503 until then."
    )

_LOGIN_WINDOW_S = 15 * 60
_LOGIN_MAX_FAILS = 10
_login_failures: Dict[str, List[float]] = {}


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _signing_key() -> bytes:
    return hmac.new(AUTH_SECRET.encode(), b"charm-studio:" + ADMIN_PASSWORD.encode(), hashlib.sha256).digest()


def make_token(now: Optional[float] = None) -> Dict[str, Any]:
    now = time.time() if now is None else now
    exp = int(now + AUTH_TOKEN_DAYS * 86400)
    payload = _b64e(json.dumps({"sub": "admin", "iat": int(now), "exp": exp}, separators=(",", ":")).encode())
    sig = _b64e(hmac.new(_signing_key(), payload.encode(), hashlib.sha256).digest())
    return {"token": f"{payload}.{sig}", "expires_at": datetime.fromtimestamp(exp, timezone.utc).isoformat()}


def verify_token(token: str, now: Optional[float] = None) -> Optional[Dict[str, Any]]:
    try:
        payload, sig = token.split(".", 1)
        expected = _b64e(hmac.new(_signing_key(), payload.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return None
        claims = json.loads(_b64d(payload))
    except (ValueError, json.JSONDecodeError):
        return None
    if claims.get("sub") != "admin" or claims.get("exp", 0) < (time.time() if now is None else now):
        return None
    return claims


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "unknown")


async def require_auth(request: Request) -> Dict[str, Any]:
    if not AUTH_CONFIGURED:
        raise HTTPException(503, "Login is not set up on the server: set ADMIN_PASSWORD and AUTH_SECRET.")
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    claims = verify_token(token.strip()) if scheme.lower() == "bearer" and token else None
    if not claims:
        raise HTTPException(401, "Please log in again.", headers={"WWW-Authenticate": "Bearer"})
    return claims


# Routers: `public` needs no login, `api` requires a valid token on every route.
public = APIRouter(prefix="/api")
api = APIRouter(prefix="/api", dependencies=[Depends(require_auth)])


class LoginIn(BaseModel):
    password: str


@public.post("/auth/login")
async def login(payload: LoginIn, request: Request):
    if not AUTH_CONFIGURED:
        raise HTTPException(503, "Login is not set up on the server: set ADMIN_PASSWORD and AUTH_SECRET.")
    ip, now = client_ip(request), time.time()
    recent = [t for t in _login_failures.get(ip, []) if now - t < _LOGIN_WINDOW_S]
    if len(recent) >= _LOGIN_MAX_FAILS:
        raise HTTPException(429, "Too many wrong passwords. Try again in 15 minutes.")
    if not hmac.compare_digest(payload.password.encode(), ADMIN_PASSWORD.encode()):
        recent.append(now)
        _login_failures[ip] = recent
        log.warning("Failed login from %s (%d in window)", ip, len(recent))
        raise HTTPException(401, "Wrong password.")
    _login_failures.pop(ip, None)
    return make_token(now)


@api.get("/auth/me")
async def auth_me(claims: Dict[str, Any] = Depends(require_auth)):
    return {"user": claims["sub"], "expires_at": datetime.fromtimestamp(claims["exp"], timezone.utc).isoformat()}


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
BOT_STEPS = [
    ("order_id", "Hi! Please send your Order ID."),
    ("product_name", "What name should we print on the product?"),
    ("charm", "Which charm would you like?"),
    ("notes", "Any notes? Reply 'none' to skip."),
]
STEP_KEYS = [k for k, _ in BOT_STEPS]
RESET_WORDS = {"restart", "reset", "hi", "hello", "start"}
SKIP_WORDS = {"none", "no", "skip", "-", "nil", "na", "n/a"}


def step_filled(fields: Dict[str, str], key: str) -> bool:
    if key not in fields:
        return False
    return key == "notes" or bool(fields[key])  # notes may be answered as empty


def next_step(fields: Dict[str, str]) -> int:
    for i, k in enumerate(STEP_KEYS):
        if not step_filled(fields, k):
            return i
    return len(STEP_KEYS)


async def send_wa(cfg: Dict[str, str], to: str, text: str) -> httpx.Response:
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


async def handle_bot_message(cfg: Dict[str, str], customer: str, text: str):
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
        await send_wa(cfg, customer, BOT_STEPS[0][1])
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
        summary = (
            "Thank you! Your order details are saved.\n\n"
            f"Order ID: {order['order_id']}\n"
            f"Name: {order['product_name'] or '-'}\n"
            f"Charm: {order['charm'] or '-'}\n"
            f"Notes: {order['notes'] or '-'}"
        )
        await send_wa(cfg, customer, summary)
        return

    await db().execute(UPSERT_CONV_SQL, biz, customer, step, fields)
    await send_wa(cfg, customer, BOT_STEPS[step][1])


async def process_webhook(body: Dict[str, Any]):
    try:
        for entry in body.get("entry", []) or []:
            for change in entry.get("changes", []) or []:
                value = change.get("value", {}) or {}
                phone_id = (value.get("metadata") or {}).get("phone_number_id")
                cfg = WA_NUMBERS.get(str(phone_id)) if phone_id else None
                if not cfg:
                    continue  # route by phone_number_id only; ignore unknown numbers
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
    tokens = {c["verify"] for c in WA_NUMBERS.values() if c.get("verify")}
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
        "callback_url": f"{public_base_url(request)}/api/wa/webhook",
        "active_conversations": active,
        "whatsapp_orders": wa_orders,
        "graph_version": WA_GRAPH_VERSION,
    }


def mask(value: str) -> str:
    return ("•" * max(len(value) - 4, 0)) + value[-4:] if value else ""


@api.get("/wa/numbers")
async def wa_numbers():
    return [
        {"logical_id": c["logical_id"], "display": c["display"], "phone_id": mask(c["phone_id"])}
        for c in WA_NUMBERS.values()
    ]


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
        raise HTTPException(404, f"Unknown WhatsApp number '{payload.logical_id}'")
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
app.include_router(public)
app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        o.strip().rstrip("/") for o in os.environ.get("CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()
    ],
    # Optional, e.g. https://charm-studio-.*\.vercel\.app to also allow Vercel preview deployments
    allow_origin_regex=os.environ.get("CORS_ORIGIN_REGEX", "").strip() or None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Matched-Pages", "X-Not-Found-Pages", "Content-Disposition"],
)
