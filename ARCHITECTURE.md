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

`backend/server.py` holds the app; `backend/security.py` holds the crypto helpers (scrypt password hashing, HMAC token signing, AES-GCM `SecretBox`, password rules) with no app imports, so it can be reviewed on its own. `server.py` is split into sections in this order:

1. **Setup**: loads `.env`, defines `SCHEMA_SQL` from `schema.sql`.
2. **Configuration and caches**: env-based config (`AUTH_SECRET`, `RESET_PASSWORD`, Resend, CORS, legacy `WA_*`), and in-memory caches `ACCOUNT`, `SETTINGS`, `WA_ALL` / `WA_NUMBERS`, reloaded from the database at startup and after every change (single process).
3. **App and lifespan**: creates the asyncpg pool (optionally in `DB_SCHEMA`), runs `schema.sql` (idempotent), loads the caches, and imports legacy `WA_*` numbers once.
4. **Authentication and account**: login, first-time setup, password change and email reset, profile, sessions, login history (see [Authentication](#authentication) below).
5. **Models**: Pydantic request bodies (`OrderIn`, `OrderPatch`, `BulkOrders`, `ExtractIn`, `TestSendIn`).
6. **Orders and stats**: CRUD, search, bulk insert, CSV export, stats.
7. **AI helpers**: `get_ai()` (provider-aware client), `claude_text()`, JSON parsing, chunking and dedupe.
8. **AI extraction endpoints**: `/api/extract`, `/api/extract/bulk-file`.
9. **PDF Label Studio**: ID detection, matching, sticker drawing, `/api/pdf/analyze`, `/api/pdf/annotate`.
10. **WhatsApp bot**: conversation state machine (wording from `SETTINGS["bot"]`), webhook endpoints, status, test send.
11. **WhatsApp numbers**: add / edit / pause / delete / check with Meta; tokens encrypted at rest.
12. **Settings**: shop profile, bot wording, label defaults, system status.
13. **Middleware**: CORS, including the exposed `X-Matched-Pages`, `X-Not-Found-Pages` and `Content-Disposition` headers.

Every route sits under the `/api` prefix. There are three routers:
- `public`, with no login: `/`, `/health`, `/auth/config`, `/auth/login`, `/auth/forgot`, `/auth/reset`, and the WhatsApp webhook `GET`/`POST /wa/webhook`.
- `session`, which accepts any valid token: `/auth/me`, `/account/setup`, `/account/password`.
- `api`, which needs a full-access token on every route.

### Database access

- `asyncpg.create_pool(DATABASE_URL, statement_cache_size=0, ...)`. Statement caching is off so the pool also works behind Supabase's transaction pooler (PgBouncer), which doesn't support prepared statements.
- A per-connection `init` registers JSON codecs, so `jsonb` columns come back as Python dicts.
- Rows are turned into plain dicts by `row_dict()`, which also converts `datetime` to an ISO-8601 string. The API never exposes database internals; every record is identified by its own `id` string (a UUID4).
- SQL is always parameterized (`$1, $2, …`). The only dynamic SQL is the `UPDATE` column lists in `PATCH /orders/{id}`, `update_account()` and `PATCH /wa/numbers/{id}`, and their column names come from code, never from request data.
- Optional `DB_SCHEMA` sets the connection `search_path` to a separate schema (created if missing). The tests use it to run against a throwaway `charm_test` schema in the production database without touching real tables.

### Authentication

One owner account (single-row `account` table) with name, email and a scrypt password hash.

```
POST /api/auth/login {email, password}
   ├─ 10 failures from one IP in 15 min -> 429 (in-memory counter; resets on restart)
   ├─ RESET_PASSWORD set and matches             -> scope "password" (or "setup" if never set up)
   ├─ account not set up: ADMIN_PASSWORD matches -> scope "setup"   (first login only)
   ├─ email matches (case-insensitive) and scrypt password verifies -> scope "full"
   └─ otherwise -> 401, recorded in login_events

token = base64url({"sub":"owner","scope":…,"iat":…,"exp":…}) + "." + base64url(HMAC-SHA256(key, payload))
key   = HMAC-SHA256(AUTH_SECRET, "charm-studio:v2:" + password_hash + ":" + token_version)
exp   = session_days (1/7/30/90) for "full"; 1 hour for "setup" / "password"

require_session(): any valid token          require_full(): scope must be "full" (else 403)
```

- **Scopes:** a `setup` token can only call `/account/setup` (name, email, new password). A `password` token, from `RESET_PASSWORD`, can only call `/account/password` without the old password. Both then return a fresh full token.
- **Revocation:** the key includes the password hash and `token_version`. Changing the password, resetting it, finishing setup, or "log out all other devices" (which bumps `token_version`) invalidates every earlier token. The endpoints that do this return a new token, so the current device stays logged in.
- **Email reset:** `POST /auth/forgot` always gives the same reply (no account enumeration), rate-limited to 5 per IP per 15 minutes. If the email matches and `RESEND_API_KEY` is set, it stores the SHA-256 of a random token (30-minute expiry) in `password_resets` and emails `FRONTEND_URL/reset-password?token=…` through the Resend API. If `FRONTEND_URL` isn't set, it uses the request's `Origin`, but only when that origin is allowed by CORS. `POST /auth/reset` accepts each token once, then deletes every other pending link.
- **Password rules** (`password_problem`, mirrored in `src/lib/session.js` for instant feedback): 8–128 characters, not in a short list of common passwords, at least 3 distinct characters, not equal to the email.
- **Fails closed:** without `AUTH_SECRET` (32+ chars), or before setup without `ADMIN_PASSWORD` or `RESET_PASSWORD`, protected routes return 503. Unedited `<placeholder>` values count as unset.
- **Frontend:** `src/lib/auth.js` stores the token in `localStorage` (memory fallback). An axios interceptor adds `Authorization: Bearer …`, and any 401 outside the public auth routes fires a logout event. `App.js` reads `/auth/me` and shows Login, AccountSetup (setup or password scope), or the app. `/reset-password` renders without logging in.
- **Downloads:** CSV export and the annotated PDF are fetched through axios as blobs so they carry the token.
- **Webhook:** `/api/wa/webhook` has to stay public because Meta calls it. The handshake is protected by `WA_VERIFY_TOKEN` or a per-number verify token; payload signatures aren't checked yet (see the gaps below).

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
channel       text  (WA number name)
customer_phone text (digits only; links to Chats)
confirmed_at  timestamptz (last confirmation template sent)
created_at    timestamptz
```

- `orders.order_id` is **not unique**: the same marketplace ID can be recorded twice, for example once from a chat and once by hand. Label matching uses the newest matching order first (orders are loaded `ORDER BY created_at DESC`; exact matches are ranked ahead of fuzzy ones).
- `wa_conversations` holds one row per customer per business number, only while a bot conversation is in progress. The row is deleted when the order is saved.
- `wa_events` is the dedupe log for incoming WhatsApp message IDs.

```
wa_messages                                    wa_contacts
───────────────────────────────────────        ─────────────────────────────────────
id text PK (uuid4)                             number_label, customer_phone  PK
number_label, customer_phone                   name (WhatsApp profile name)
direction  in|out                              last_message_at, last_inbound_at
kind, body                                     last_preview, unread
                                               (unread resets when opened)
status  received|sent|delivered|read|failed
source  customer|bot|staff|phone_app
error, created_at
media_id, media_mime, media_name (photos, voice notes, files)
```

- `wa_messages` is every message in and out, including replies sent from the WhatsApp Business phone app (coexistence `smb_message_echoes`). Status updates only move forward (`sent → delivered → read`, or `failed`).
- `wa_contacts` is one row per chat, for the Chats list. `last_inbound_at` drives the 24-hour reply window.
- `wa_numbers` also has `provider` (`meta` | `360dialog`), `bot_mode` (`ask` | `read` | `off`), `webhook_key` (the secret in a 360dialog number's webhook URL) and `waba_id` (Meta only: the WhatsApp Business Account that owns the number's templates). Deleting a number keeps its message history.

```
account (1 row)               wa_numbers                         app_settings          login_events        password_resets
──────────────────────        ───────────────────────────        ──────────────        ───────────────     ────────────────
id            = 1             id               text PK           key   text PK         id bigserial PK     token_hash text PK
name, email                   label            text UNIQUE       value jsonb           at, ip, user_agent  expires_at
password_hash (scrypt)        display, phone_id (UNIQUE)          (shop, bot, labels,   method, success     used_at
token_version, session_days   token_enc        AES-GCM "v1:…"      wa_env_imported)     (kept 90 days)
password_changed_at           token_last4, verify_token_enc
                              active (pause)
```

- `wa_numbers.label` is the number's name. It's also the conversation key (`wa_conversations.business_number_id`) and the order `channel`. Renaming a number moves its in-progress chats; old orders keep the old name.
- Tokens are encrypted with `SecretBox` (AES-256-GCM, key = HMAC-SHA256(`AUTH_SECRET`, "charm-studio:secrets")). If `AUTH_SECRET` changes, they can't be decrypted: the number shows "Re-enter token" and is skipped by the bot.
- All tables have Row Level Security enabled with no policies. That blocks Supabase's public REST API (anon or authenticated keys). The backend connects as the table owner, which RLS doesn't restrict.

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
  index.js, App.js            Auth state machine + Router: / /orders /extract /labels /bot /settings, /reset-password
  lib/api.js                  axios instance (baseURL = REACT_APP_BACKEND_URL + /api) and one function per endpoint
  lib/auth.js, lib/session.js token storage; SessionContext (me, settings); client-side password rules
  lib/utils.js                cn(), date helpers, emptyOrder()
  components/Layout.jsx       fixed sidebar (desktop) / top bar and drawer (mobile), <Outlet/>
  components/common.jsx       PageHeader, StatCard, SourceBadge, EmptyState, EditableRows
  components/ui/              shadcn-style primitives on Radix: button, primitives (input, card, badge,
                              switch, table, alert…), overlays (dialog, confirm, tabs, accordion, select)
  components/AuthShell.jsx    card layout for Login, AccountSetup, ResetPassword; PasswordInput.jsx
  pages/                      Dashboard, Orders, WhatsAppExtract, LabelStudio, WhatsAppBot, Settings,
                              Login, AccountSetup, ResetPassword
  pages/settings/             AccountTab, WhatsAppNumbersTab, ShopBotTab, LabelsTab, SecurityTab
```

- State is mostly local to each page (`useState`). The logged-in account and app settings live in `SessionContext` (used by the sidebar, Settings and Label Studio defaults).
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
     cfg = WA_NUMBERS[value.metadata.phone_number_id]   (unknown or paused number -> ignore)
     for each text message:
        INSERT wa_events(message_id) ON CONFLICT DO NOTHING   (duplicate delivery -> skip)
        handle_bot_message(cfg, from, text)

handle_bot_message:
   "hi|hello|start|reset|restart"  -> reset the conversation to step 0, send bot.ask_order_id
   message has 6+ words            -> AI extracts {order_id, product_name, charm, notes}, fills blanks
   new chat, short, no digits      -> just greet
   otherwise                       -> the reply answers the current step ("none/no/skip/-" = empty notes)
   next = first unanswered step
   all answered -> INSERT orders (source=whatsapp, channel=logical id, order_id or "wa-xxxxxxxx"),
                   DELETE the conversation, send bot.thank_you with {shop_name} {order_id} {name} {charm} {notes}
   else         -> UPSERT wa_conversations(step, fields), send the next bot.ask_* question

Replies: POST https://graph.facebook.com/{WA_GRAPH_VERSION}/{phone_id}/messages  (Bearer token)
```

Steps: `order_id → product_name → charm → notes`. `notes` counts as answered even when empty; the other steps need a value.

Routing is by `phone_number_id` only, so several business numbers can share one deployment and one webhook URL. Each order records which number it came from in `channel`.

`GET /api/wa/webhook` handles Meta's verification handshake. It echoes `hub.challenge` when `hub.verify_token` matches `WA_VERIFY_TOKEN` or any saved number's verify token.

**Bot modes.** `ask` is the flow above. `read` never messages customers: each incoming message schedules a debounced task (`READ_DEBOUNCE_SECONDS`, default 20). When the chat goes quiet, the AI reads the recent messages with `CHAT_EXTRACT_SYSTEM` (or the regex `detect_ids` when no AI is set up) and `save_extracted_order` creates orders or fills only *blank* fields of existing ones, so staff edits win. `off` only records messages.

**360dialog.** Same message JSON as Meta, sent to `D360_BASE_URL` (`https://waba-v2.360dialog.io`) `/messages` with a `D360-API-KEY` header. Its webhooks aren't signed, so each number gets `POST /api/wa/webhook/n/{number_id}/{webhook_key}` with a random key; adding a number sets it through `POST /v1/configs/webhook`. Payloads use Meta's `entry[].changes[].value` shape; a flat `value` is accepted too.

**Chats (inbox).** `/api/inbox/*` reads `wa_contacts` and `wa_messages`. Staff replies go through `send_wa(..., source="staff")` and are refused with 409 outside the 24-hour window.

**Media.** Incoming photos, videos, voice notes, stickers and documents keep WhatsApp's `media_id`, mime type and file name in `wa_messages`; the caption (or file name) is the body, so captioned photos also feed the read-only bot. `GET /api/inbox/media/{message_id}` fetches the file on demand (Meta: `GET /{media_id}` for a short-lived URL, then download with the bearer token; 360dialog: `GET {D360_BASE}/{media_id}`, then the same URL with `lookaside.fbsbx.com` swapped for the 360dialog host and the API key) and keeps up to 40 MB in an in-memory cache. Files aren't copied to our database, so they disappear when WhatsApp drops them (about 30 days). `POST /api/inbox/send-media` uploads the file (`POST /media`), sends it by id, and caches the bytes so the sent copy shows immediately. The browser loads files with the login token and turns them into `blob:` URLs.

**Templates.** `GET /api/inbox/templates` loads the number's templates (Meta: `GET /{waba_id}/message_templates`; 360dialog: `GET /v1/configs/templates`), cached 5 minutes per number. `normalize_template` keeps the text header, body, footer and button labels, lists the blanks (`{{1}}` positional or `{{name}}` named), and marks a template unsendable if it isn't approved, has a media header, or has a link button with a variable. `POST /api/inbox/send-template` checks every blank is filled (WhatsApp rejects new lines in variables, so whitespace is collapsed), sends `type: template` through `send_payload` (which records it in `wa_messages` with `kind = template` and the filled-in text), and sets `orders.confirmed_at` when an `order_id` is given. Templates don't reopen the 24-hour window. Which order field fills each blank is chosen in the browser and remembered in `app_settings.templates` (`maps["name|language"]`); typed text is never remembered as-is.

**Late replies.** `app_settings.templates.late_reply` names a template whose saved mapping contains the `{message}` token. `POST /api/inbox/send` checks the window with `reply_window_open`; when it's closed and a late-reply template is set (`late_reply_template_name()`, also returned as `number.late_reply` in the thread so the composer stays enabled), `send_late_reply` fills the blanks server-side from the contact name (default "there"), the customer's newest order, the shop name and the typed text, then sends through the same `deliver_template` used by `send-template`. A blank whose value is empty returns 409 rather than sending an incomplete template. The frontend polls: the chat list every 5 s, an open chat every 4 s, the unread badge every 15 s.

Numbers are managed in Settings (`/api/wa/numbers`). Adding a number or changing its token or phone ID first calls `GET graph.facebook.com/{version}/{phone_id}` with the token. A rejection returns **424**, and the UI offers "Save anyway" (`skip_check`). The check also fills in the display number.

## Configuration

All configuration comes from environment variables: `backend/.env` locally and the Render dashboard in production. Nothing is hard-coded.

| Variable | Used for |
|---|---|
| `DATABASE_URL`, `DB_POOL_SIZE` | Supabase connection (Session pooler URI) and pool size |
| `CORS_ORIGINS`, `CORS_ORIGIN_REGEX` | allowed frontend origins; the regex is for Vercel preview URLs |
| `AI_PROVIDER` | `anthropic` (default) or `ollama` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Claude |
| `OLLAMA_API_KEY`, `OLLAMA_MODEL`, `OLLAMA_BASE_URL` | Ollama Cloud or a self-hosted server |
| `WA_GRAPH_VERSION`, `WA_VERIFY_TOKEN` | WhatsApp Cloud API version, webhook verify token |
| `WA_NUMBERS`, `WA_<ID>_*` | legacy; imported into Settings once |
| `AUTH_SECRET` | signs logins and encrypts saved tokens (32+ chars); don't change once numbers are saved |
| `ADMIN_PASSWORD` | first login only (account setup) |
| `RESET_PASSWORD` | emergency login that forces a new password; remove after use |
| `RESEND_API_KEY`, `RESEND_FROM`, `FRONTEND_URL` | password reset emails and where their links point |
| `DB_SCHEMA` | optional separate Postgres schema (testing) |
| `PUBLIC_BASE_URL` | optional override for the public URL used for webhook callbacks |
| `READ_DEBOUNCE_SECONDS` | read-only bot: quiet time before reading a chat (default 20) |
| `D360_BASE_URL` | 360dialog API base (default `https://waba-v2.360dialog.io`) |
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
- Passwords are stored as scrypt hashes; reset links are stored only as SHA-256 hashes, expire in 30 minutes and work once.
- WhatsApp tokens are AES-GCM encrypted at rest and never returned by the API (only the last 4 characters).
- Recent logins and account changes are recorded in `login_events` and shown in Settings → Security.
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
- **The account, settings and number caches live in memory.** That's correct for one instance; running several instances would need them reloaded from the database on each request (or a pub/sub signal).
- **The login and reset rate limits are in memory** too, so they reset on restart and aren't shared between instances.

## Extension points

- **New marketplace ID formats**: add a regex to `ID_PATTERNS` (order matters; earlier patterns win).
- **New order fields**: update `schema.sql` (add a column with `ALTER TABLE … ADD COLUMN IF NOT EXISTS`), `ORDER_COLUMNS`, `build_order()`, `order_args()`, the Pydantic models, the extraction prompts, and the form and columns in `Orders.jsx` and `EditableRows`.
- **Another AI provider**: add a branch to `get_ai()` and `claude_text()`.
- **More bot steps**: extend `STEP_KEYS` and add an `ask_<step>` entry to `DEFAULT_SETTINGS["bot"]` and `BotSettingsIn`. Then add the field to `BOT_FIELDS` in `ShopBotTab.jsx` and `STEP_LABELS` in `WhatsAppBot.jsx`.
- **A new setting**: add a section or key to `DEFAULT_SETTINGS` and a Pydantic model with a `PUT /settings/<section>` route. Stored values are merged over the defaults, so older rows keep working.
