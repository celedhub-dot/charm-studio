# Architecture

How Charm.Studio is built, how data moves through it, and why it is shaped this way. For setup and deployment steps see [README.md](README.md); for project background, conventions and decisions see [CONTEXT.md](CONTEXT.md).

## System overview

```
                         ┌────────────────────────────┐
  Seller's browser ────> │  Vercel: React SPA (CRA)   │
                         │  frontend/                 │
                         └─────────────┬──────────────┘
                                       │ HTTPS, JSON / multipart  (axios, REACT_APP_BACKEND_URL)
                                       v
  Meta WhatsApp ──webhook──> ┌────────────────────────────┐ ──> Anthropic API (Claude)
  Cloud API  <──send msg──── │  Render: FastAPI (uvicorn) │      or Ollama (Anthropic-compatible)
                             │  backend/server.py         │
                             └─────────────┬──────────────┘
                                           │ asyncpg pool (TLS, Session pooler)
                                           v
                             ┌────────────────────────────┐
                             │  Supabase: Postgres        │
                             │  orders, wa_conversations, │
                             │  wa_events                 │
                             └────────────────────────────┘
```

| Part | Tech | Hosted on | Source |
|---|---|---|---|
| Frontend | React 18, React Router 7, Tailwind 3, Radix (shadcn-style), Phosphor icons, Sonner, axios, Papa Parse | Vercel (static build + SPA rewrite) | `frontend/` |
| Backend | Python, FastAPI, asyncpg, PyMuPDF, httpx, Anthropic SDK | Render web service | `backend/server.py` |
| Database | Postgres | Supabase | `backend/schema.sql` |
| AI | Claude `claude-sonnet-5-5` (default) or an Ollama model | Anthropic / Ollama Cloud | `claude_text()` in `server.py` |
| Messaging | WhatsApp Cloud API (Graph API) | Meta | `/api/wa/*` in `server.py` |

The backend is a single stateless process. All durable state lives in Postgres, so Render can restart or redeploy it at any time.

## Backend

`backend/server.py` is one module, split into sections in this order:

1. **Setup**: loads `.env`, reads config, defines `SCHEMA_SQL` from `schema.sql`.
2. **WhatsApp number config**: `load_wa_numbers()` builds `phone_number_id → {logical_id, token, display, verify}` from `WA_NUMBERS` and `WA_<ID>_*` env vars.
3. **App and lifespan**: creates the asyncpg pool and runs `schema.sql` on startup (idempotent `CREATE ... IF NOT EXISTS`), and closes the pool on shutdown.
4. **Authentication**: password login, signed tokens, and the `require_auth` dependency (see [Authentication](#authentication) below).
5. **Models**: Pydantic request bodies (`OrderIn`, `OrderPatch`, `BulkOrders`, `ExtractIn`, `TestSendIn`).
6. **Orders and stats**: CRUD, search, bulk insert, CSV export, stats.
7. **AI helpers**: `get_ai()` (provider-aware client), `claude_text()`, JSON parsing, chunking and dedupe.
8. **AI extraction endpoints**: `/api/extract`, `/api/extract/bulk-file`.
9. **PDF Label Studio**: ID detection, matching, sticker drawing, `/api/pdf/analyze`, `/api/pdf/annotate`.
10. **WhatsApp bot**: conversation state machine, webhook endpoints, status, test send.
11. **Middleware**: CORS, including the exposed `X-Matched-Pages`, `X-Not-Found-Pages` and `Content-Disposition` headers.

Every route sits under the `/api` prefix. There are two routers: `public` (no login: `/`, `/health`, `/auth/login`, and the WhatsApp webhook `GET`/`POST /wa/webhook`) and `api`, which carries `dependencies=[Depends(require_auth)]` so every route on it needs a valid token.

### Database access

- `asyncpg.create_pool(DATABASE_URL, statement_cache_size=0, ...)`. Statement caching is off so the pool also works behind Supabase's transaction pooler (PgBouncer), which doesn't support prepared statements.
- A per-connection `init` registers JSON codecs, so `jsonb` columns come back as Python dicts.
- Rows are turned into plain dicts by `row_dict()`, which also converts `datetime` to an ISO-8601 string. The API never exposes database internals; every record is identified by its own `id` string (a UUID4).
- SQL is always parameterized (`$1, $2, …`). The only dynamic SQL is the `UPDATE` column list in `PATCH /orders/{id}`, and its column names come from the Pydantic model's fields, never from request data.

### Authentication

The app has one user, the seller, so it uses a single admin password rather than user accounts.

```
POST /api/auth/login {password}
   ├─ 10 wrong passwords from one IP within 15 min -> 429 (in-memory counter; resets on restart)
   ├─ hmac.compare_digest(password, ADMIN_PASSWORD) fails -> 401
   └─ ok -> {token, expires_at}

token = base64url({"sub":"admin","iat":…,"exp":…}) + "." + base64url(HMAC-SHA256(key, payload))
key   = HMAC-SHA256(AUTH_SECRET, "charm-studio:" + ADMIN_PASSWORD)

every protected route -> require_auth():
   auth not configured -> 503 "Login is not set up"
   missing / bad signature / expired token -> 401
```

- **Revocation:** the signing key is derived from both `AUTH_SECRET` and `ADMIN_PASSWORD`, so changing either one invalidates every token already issued (logs every device out). There is no per-token revocation list.
- **Fails closed:** auth counts as configured only when `ADMIN_PASSWORD` is at least 8 characters, `AUTH_SECRET` at least 32, and neither is an unedited `<placeholder>` from `.env.example`. Otherwise every protected route returns 503, so a misconfigured deploy never runs open.
- **Frontend:** `src/lib/auth.js` stores the token in `localStorage` (falling back to memory if storage is blocked). An axios request interceptor adds `Authorization: Bearer …`. A response interceptor turns any 401 into a logout event, which `App.js` handles by showing the login screen. On load, a saved token is checked with `GET /api/auth/me`.
- **Downloads:** CSV export and the annotated PDF are fetched through axios as blobs, so they carry the token. A plain `<a href>` link can't send it.
- **Webhook:** `/api/wa/webhook` has to stay public because Meta calls it. It is protected by the verify token for the handshake, and should also check Meta's signature (see the gaps below).

### Data model

```
orders                                   wa_conversations                         wa_events
───────────────────────────────          ─────────────────────────────────        ──────────────────────
id            text  PK (uuid4)           business_number_id text  ┐ PK            message_id  text PK
order_id      text  (Meesho/Flipkart)    customer_phone     text  ┘               received_at timestamptz
product_name  text  (name to print)      step               int   (0..3)
charm         text                       fields             jsonb (answers so far)
notes         text                       started_at         timestamptz
source        text  manual|ai|csv|whatsapp  updated_at      timestamptz
channel       text  (logical WA number id)
created_at    timestamptz
```

- `orders.order_id` is **not unique**: the same marketplace ID can be recorded twice, for example once from a chat and once by hand. Label matching uses the newest matching order first (orders are loaded `ORDER BY created_at DESC`; exact matches are ranked ahead of fuzzy ones).
- `wa_conversations` holds one row per customer per business number, only while a bot conversation is in progress. The row is deleted when the order is saved.
- `wa_events` is the dedupe log for incoming WhatsApp message IDs.
- All three tables have Row Level Security enabled with no policies. That blocks Supabase's public REST API (anon or authenticated keys). The backend connects as the table owner, which RLS doesn't restrict.

### AI provider layer

```
claude_text(system, user, max_tokens, effort)
   │
   ├─ AI_PROVIDER=anthropic ─> AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
   │                           beta.messages.create(model=claude-sonnet-5-5,
   │                             betas=[server-side-fallback-2026-07-01],
   │                             extra_body={fallbacks:"default", output_config:{effort}})
   │                           stop_reason == "refusal"  ->  RuntimeError
   │
   └─ AI_PROVIDER=ollama ────> AsyncAnthropic(base_url=OLLAMA_BASE_URL, auth_token=OLLAMA_API_KEY,
                                 anthropic-version: 2023-06-01)
                               messages.create(model=OLLAMA_MODEL)   # no Anthropic-only extras
```

- Both providers go through the Anthropic SDK; only the base URL, auth and model change. Ollama exposes an Anthropic-compatible `/v1/messages` endpoint.
- Passing an explicit `auth_token` to the Ollama client stops the SDK from reading `ANTHROPIC_API_KEY` from the environment, so the Anthropic key is never sent to Ollama.
- The client is created lazily on the first AI call, so the app starts and every non-AI feature works without any AI key.
- `parse_json_any()` handles replies wrapped in Markdown fences or surrounded by stray prose, and `_clean_row()` normalizes each row to the four string fields.

### Frontend

```
src/
  index.js, App.js            Router: / /orders /extract /labels /bot, plus <Toaster/>
  lib/api.js                  axios instance (baseURL = REACT_APP_BACKEND_URL + /api) and one function per endpoint
  lib/utils.js                cn(), date helpers, emptyOrder()
  components/Layout.jsx       fixed sidebar (desktop) / top bar and drawer (mobile), <Outlet/>
  components/common.jsx       PageHeader, StatCard, SourceBadge, EmptyState, EditableRows
  components/ui/              shadcn-style primitives on Radix: button, primitives (input, card, badge,
                              switch, table, alert…), overlays (dialog, confirm, tabs, accordion, select)
  pages/                      Dashboard, Orders, WhatsAppExtract, LabelStudio, WhatsAppBot
```

- State is local to each page (`useState`); there is no global store. Each page fetches what it needs on mount.
- `EditableRows` is the shared preview grid for AI results and CSV imports: rows stay editable until the user clicks Save, which calls `POST /orders/bulk`.
- The theme lives in `tailwind.config.js`: `forest` `#2D4A22`, `terracotta` `#D97757`, `cream` `#F7F5F0`, Manrope for headings and IBM Plex Sans for body text.
- Every interactive element has a `data-testid`.

## Key flows

### 1. Manual order and CSV import

```
Orders page ──POST /api/orders──────────────> INSERT orders (source=manual)
CSV file ──Papa Parse in browser──> preview (EditableRows) ──POST /api/orders/bulk──> INSERT … (source=csv), one transaction
```

The CSV is parsed client-side, and header aliases are mapped to the four fields (`order_id`/`sub order no`, `name`/`print name`, …). The server only ever receives clean JSON.

### 2. AI extraction from WhatsApp chats

```
Paste text ──POST /api/extract──> claude_text(EXTRACT_SYSTEM, text) ──> parse_orders() ──> {orders}

Chat .txt ──POST /api/extract/bulk-file──> chunk_text(~15,000 chars, split on line boundaries)
                                         ──> asyncio.gather(claude_text per chunk), at most 3 at a time
                                         ──> merge ──> dedupe_orders(by normalized order_id;
                                                       later non-empty fields fill earlier blanks)
                                         ──> {orders, chunks_processed, duplicates_removed}

Either way: the preview stays editable in the browser ──POST /api/orders/bulk──> source=ai
```

Nothing is saved until the seller reviews the rows and clicks **Save all**.

### 3. PDF Label Studio

```
Upload PDF ──POST /api/pdf/analyze──────────────────────────────────────────────────────────┐
   for each page:  page.get_text()  ──>  detect_ids()  ──>  match_orders(ids, ALL orders)   │
                   status = matched | not_found | no_id                                     │
                   thumbnail = PNG at 0.5 zoom, base64                                      │
   <── {summary, pages[]} ──────────────────────────────────────────────────────────────────┘

The seller optionally assigns an order to a page by hand (overrides: page -> order uuid), or
creates a new order pre-filled with the detected ID.

Generate ──POST /api/pdf/annotate (file, position, skip_unmatched, font_size, overrides)──>
   for each page:  override ?? first match
     matched   -> green "CUSTOMISATION" sticker: Name / Charm / Notes
     unmatched -> red "ORDER NOT FOUND" sticker with the detected ID (unless skip_unmatched)
   <── application/pdf + X-Matched-Pages + X-Not-Found-Pages
```

**ID detection** applies these regexes to each page's text, in order, and drops hits that are just part of an ID already found:

| Pattern | Marketplace | Example |
|---|---|---|
| `\b\d{10,}[_-]\d{1,}\b` | Meesho sub-order number | `123456789012_1` |
| `\bOD\d{15,}\b` (case-insensitive) | Flipkart order ID | `OD123456789012345678` |
| `\b\d{13,}\b` | fallback long numeric | `9876543210123456` |

**Matching** (`ids_match`): both IDs are normalized (non-alphanumerics removed, uppercased). They match if they are equal, or if the shorter one is at least 8 characters long and any 8-character run of it appears in the longer one. All orders are loaded once per request and matched in memory.

**Stickers** (`draw_sticker`) are 180 pt wide and sit 14 pt from the chosen corner. They have a white box with a thin border, a filled header strip and Helvetica text. Each line is cut to 30 characters and then to the box width with `...`; base-14 Helvetica can't draw the `…` character. The sticker is deliberately small and in a corner so it never covers the barcode.

### 4. WhatsApp bot

```
Meta ──POST /api/wa/webhook──> respond 200 immediately ── BackgroundTask: process_webhook(body)
   for entry.changes[].value:
     cfg = WA_NUMBERS[value.metadata.phone_number_id]   (unknown number -> ignore)
     for each text message:
        INSERT wa_events(message_id) ON CONFLICT DO NOTHING   (duplicate delivery -> skip)
        handle_bot_message(cfg, from, text)

handle_bot_message:
   "hi|hello|start|reset|restart"  -> reset the conversation to step 0, ask for the Order ID
   message has 6+ words            -> AI extracts {order_id, product_name, charm, notes}, fills blanks
   new chat, short, no digits      -> just greet
   otherwise                       -> the reply answers the current step ("none/no/skip/-" = empty notes)
   next = first unanswered step
   all answered -> INSERT orders (source=whatsapp, channel=logical id, order_id or "wa-xxxxxxxx"),
                   DELETE the conversation, send a summary
   else         -> UPSERT wa_conversations(step, fields), send the next question

Replies: POST https://graph.facebook.com/{WA_GRAPH_VERSION}/{phone_id}/messages  (Bearer token)
```

Steps: `order_id → product_name → charm → notes`. `notes` counts as answered even when empty; the other steps need a value.

Routing is by `phone_number_id` only, so several business numbers can share one deployment and one webhook URL. Each order records which number it came from in `channel`.

`GET /api/wa/webhook` handles Meta's verification handshake. It echoes `hub.challenge` when `hub.verify_token` matches `WA_VERIFY_TOKEN` or any per-number `WA_<ID>_VERIFY`.

## Configuration

All configuration comes from environment variables: `backend/.env` locally and the Render dashboard in production. Nothing is hard-coded.

| Variable | Used for |
|---|---|
| `DATABASE_URL`, `DB_POOL_SIZE` | Supabase connection (Session pooler URI) and pool size |
| `CORS_ORIGINS`, `CORS_ORIGIN_REGEX` | allowed frontend origins; the regex is for Vercel preview URLs |
| `AI_PROVIDER` | `anthropic` (default) or `ollama` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Claude |
| `OLLAMA_API_KEY`, `OLLAMA_MODEL`, `OLLAMA_BASE_URL` | Ollama Cloud or a self-hosted server |
| `WA_GRAPH_VERSION`, `WA_VERIFY_TOKEN`, `WA_NUMBERS`, `WA_<ID>_PHONE_ID/TOKEN/DISPLAY/VERIFY` | WhatsApp Cloud API |
| `ADMIN_PASSWORD`, `AUTH_SECRET`, `AUTH_TOKEN_DAYS` | login password, token-signing secret (32+ chars), token lifetime (default 30 days) |
| `PUBLIC_BASE_URL` | optional override for the callback URL shown on the Bot page |
| `REACT_APP_BACKEND_URL` (frontend) | API base URL, baked into the bundle at build time |

## Deployment

```
GitHub (celedhub-dot/charm-studio, branch main)
   ├──> Render Blueprint (render.yaml, rootDir backend)   pip install; uvicorn server:app --port $PORT
   │      health check: GET /api/health  (runs SELECT 1)
   └──> Vercel project (Root Directory frontend)          CI=false npm run build -> build/
          frontend/vercel.json rewrites /(.*) -> /index.html
```

- Render pins `PYTHON_VERSION=3.11.9`. Local development has also been run on Python 3.15, which is why `requirements.txt` uses plain `uvicorn`: the `[standard]` extras had no 3.15 wheels.
- Supabase's direct connection is IPv6-only, and Render can't reach it. Use the **Session pooler** URI.
- Render's free plan sleeps after about 15 minutes idle, so the first request after a sleep (including a WhatsApp webhook) takes about 30–60 s.

## Security model and known gaps

What's in place:
- **Password login** on every API route except health, login and the WhatsApp webhook, with signed, expiring tokens and a lockout after 10 wrong passwords (see [Authentication](#authentication)).
- Secrets live only in backend env vars; the frontend bundle contains just the API URL. Both `.env` files are git-ignored.
- RLS blocks Supabase's public REST API from reading the tables.
- WhatsApp tokens never leave the server. `/api/wa/numbers` masks phone number IDs.
- SQL is parameterized.

**Gaps still open:**

1. **Webhook payloads aren't verified.** `POST /api/wa/webhook` doesn't check Meta's `X-Hub-Signature-256` header, so a forged request could create orders. The fix is to verify an HMAC-SHA256 of the raw body using the Meta App Secret.
2. **Webhook processing isn't durable.** A message ID is recorded in `wa_events` *before* it is handled. If the process dies mid-handling (for example, Render restarts), Meta's retry is treated as a duplicate and that message is dropped. A queue, or marking events done only after handling, would fix it.

## Limitations and scaling notes

- **Label matching loads every order into memory** on each analyze or annotate request. That's fine up to tens of thousands of orders. Beyond that, filter in SQL first (for example, normalized `order_id` prefixes).
- **The fuzzy 8-character rule can produce false positives** between long numeric IDs that happen to share digits. When a page has more than one match, the UI flags it and the first match is used.
- **Analyze returns every page thumbnail as base64 inside one JSON response.** Very large PDFs (hundreds of pages) produce big responses and use a lot of memory on a small Render instance.
- **PDFs are processed fully in memory**, so the instance's RAM caps the upload size.
- **Pages with a `/Rotate` value aren't specially handled.** The sticker position is computed from `page.rect`, so check the output on rotated label layouts.
- **Helvetica can't draw non-Latin scripts** (Devanagari, for example); those names won't render on stickers.
- **`wa_events` grows forever.** A periodic `DELETE … WHERE received_at < now() - interval '30 days'` would keep it small.
- **One process, no background worker.** Webhook tasks run inside the web process.

## Extension points

- **New marketplace ID formats**: add a regex to `ID_PATTERNS` (order matters; earlier patterns win).
- **New order fields**: update `schema.sql` (add a column with `ALTER TABLE … ADD COLUMN IF NOT EXISTS`), `ORDER_COLUMNS`, `build_order()`, `order_args()`, the Pydantic models, the extraction prompts, and the form and columns in `Orders.jsx` and `EditableRows`.
- **Another AI provider**: add a branch to `get_ai()` and `claude_text()`.
- **More bot steps**: extend `BOT_STEPS`. `next_step()` and the frontend progress bar follow from it (`STEP_LABELS` in `WhatsAppBot.jsx`).
