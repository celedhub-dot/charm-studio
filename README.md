# Charm.Studio

Charm.Studio is for a small seller who takes customised-charm orders on WhatsApp and ships them through Meesho or Flipkart. It records each customer's customisation (name on product, charm, notes) and stamps it onto the seller's A4 PDF shipping labels by matching Order IDs.

**Docs:** this README covers setup and deployment. [ARCHITECTURE.md](ARCHITECTURE.md) explains how the system works (components, data model, key flows, security gaps). [CONTEXT.md](CONTEXT.md) gives the project background, glossary, conventions, decision log and open items.

## Features

- **Chats (team inbox):** every customer chat from your WhatsApp numbers in one place. Search by phone, name, order ID or anything the customer wrote. Each chat shows the orders the bot saved for that customer, which staff can edit, and staff reply from the app through the business number (WhatsApp allows free-form replies within 24 hours of the customer's last message; after that, or to start a chat, staff send an approved **template**). Customers' photos, voice notes, videos, stickers and files show in the chat, and staff can send photos, PDFs and other files (paperclip button, or paste an image). Messages your team sends from the WhatsApp Business phone app show up too (coexistence). Delete a chat with the bin button in its header (after a warning: deleted chats can't be recovered; saved orders are kept and the customer's WhatsApp isn't affected). One shared login.
- **Orders:** add, search, edit and delete orders inline; import and export CSV; delete all (with confirmation). **Filters:** by date (any day, today, yesterday, one date or a range), customer phone and order ID (partial matches; spaces, dashes and +91 ignored); Export CSV follows the filters. **Order date:** the Meesho/Flipkart order date, read from the customer's chat by the bot or from the shipping label in Label Studio (never overwrites one already saved); date filters use it, or the date the order was saved when it isn't known yet. **Order sheet PDF:** a printable table for a date, a range, a phone number or an order ID, grouped under a heading per order date. **Send confirmation:** sends your approved order-confirmation template on WhatsApp, filled in from the order, and marks the order confirmed.
- **WhatsApp Extract:** paste chat text, or upload an exported chat `.txt`, and AI turns it into orders you can edit before saving. Large chats are split into chunks and duplicates are merged. Staff pick the **model** (Claude Haiku 5.5 or Sonnet 5.5) and **effort** for each run, with a rough cost hint; "Default" uses the server's `ANTHROPIC_EXTRACT_MODEL` / `ANTHROPIC_EXTRACT_EFFORT`, and the choice is remembered in each browser.
- **Label Studio:** drop in the day's label PDF (one file with all labels) and see each page's detected Order ID, matched order and printed order date. Stamping also saves that order date to matching orders that don't have one. Fix unmatched pages by hand, then download the print-ready PDF: a green CUSTOMISATION box (name, charm, notes) **right below each label with a small gap**. On A4 label + invoice pages (Meesho, Flipkart) the invoice part is moved down to make room, so nothing is covered. Small 4x6 labels (Flipkart) are laid out **4 per A4 sheet** with the box under each and light cut guides: print at actual size (100%), not "4 per sheet". Other layouts get the box under the label's content, or in the chosen corner as a last resort. Order IDs: Meesho sub-order and Flipkart OD numbers first, then the number after "Order No." (other channels); SKU codes and courier AWB numbers are ignored.
- **WhatsApp Bot:** each number has a bot mode. **Read only** quietly reads every chat and saves the order ID, name, charm and notes it finds, never messaging customers (use this when staff also chat on the number). **Ask questions** collects the order ID, name, charm and notes (plus colour and quantity when given) and asks only for what's missing. It waits about 20 seconds after the customer's last message (`BOT_REPLY_WAIT_SECONDS`), so details split over several messages are read together. With an Anthropic key, the AI reads each reply in any form or language using the recent chat (including your own greeting's numbered list) and lets customers correct details; without one, labelled details ("name AARAV", "charm no 5", "qty 2") and replies laid out like your numbered list are still picked out. The AI only fills order fields: everything the bot sends is your own text from Settings, so it never answers off-topic requests, and off-topic messages are never saved as order details. **Off** just stores messages for Chats. Supports several numbers, connected directly through Meta or through 360dialog.
- **Dashboard:** order counts (total, today, from WhatsApp, by source), recent orders and shortcuts.
- **Settings:** your account (name, email, password), WhatsApp numbers (add, check, pause, delete; tokens stored encrypted), message templates (what fills each blank, which template "Send confirmation" and late replies use), shop name, the bot's message wording, Label Studio defaults, and security (session length, log out other devices, recent activity, system status).

- **Backend:** FastAPI, asyncpg (Supabase Postgres), PyMuPDF, Anthropic SDK (Claude `claude-sonnet-5-5` by default, or Ollama), Meta WhatsApp Cloud API
- **Frontend:** React (CRA), React Router v7, Tailwind CSS, shadcn-style components on Radix, Phosphor Icons, Sonner, axios
- **Hosting:** Vercel (frontend), Render (API) and Supabase (database). Code lives on GitHub.

```
backend/   server.py, security.py, schema.sql, requirements.txt, .env.example, tests/
frontend/  React app (src/lib/api.js is the axios client), vercel.json
render.yaml  Render Blueprint for the API
```

```
Browser ──> Vercel (React) ──HTTPS──> Render (FastAPI) ──> Supabase (Postgres)
Meta / 360dialog ──webhook───────────┘        └──> Claude / Ollama API
```

## 1. Database (Supabase)

1. Create a Supabase project.
2. Go to **Project Settings → Database → Connection string** and copy the **Session pooler** URI. It supports IPv4, which Render needs; the direct connection is IPv6-only. Fill in your database password.
3. You don't need to run anything else. The backend runs `backend/schema.sql` on startup, and it is idempotent. You can also paste the file into the Supabase SQL editor yourself.

The tables have Row Level Security enabled with no policies, so Supabase's public REST API (anon key) cannot read them. The backend connects as the table owner, so RLS does not apply to it.

## 2. Run locally

Backend (Python 3.11+):

```bash
cd backend
cp .env.example .env        # then fill DATABASE_URL, AUTH_SECRET, ADMIN_PASSWORD, the AI key
python -m venv .venv && .venv/Scripts/activate   # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt && uvicorn server:app --reload --port 8001
```

Frontend (npm or yarn):

```bash
cd frontend
cp .env.example .env        # REACT_APP_BACKEND_URL=http://localhost:8001
npm install && npm start
```

Open http://localhost:3000.

**Local and live share one database.** If your local `backend/.env` uses the same `DATABASE_URL` as Render, also set `DB_SCHEMA=charm_dev` there. Local data then lives in its own schema and never touches the live account or orders. To create a local test account (this skips the password rules, so simple test passwords work; it refuses to run without `DB_SCHEMA`):

```bash
cd backend
.venv/Scripts/python.exe scripts/seed_dev_account.py --email test@charm.local --password <test-password>
```

## Logging in and your account

- **First login:** enter the `ADMIN_PASSWORD` from the server's environment. The app then asks for your name, email and a new password, which is stored hashed (scrypt) in the database. After that you always log in with **email + password**, and `ADMIN_PASSWORD` is no longer used (you can delete it).
- **Change your name, email or password** in **Settings → Account**. Changing your email needs your current password. Changing your password keeps you logged in on this device and logs out every other one.
- **Forgot password?** on the login screen emails a one-time reset link (valid 30 minutes) through [Resend](https://resend.com). Set `RESEND_API_KEY` and `FRONTEND_URL` on the server to turn it on. With Resend's default test sender (`onboarding@resend.dev`), emails only reach the address you signed up to Resend with, so make that your account email (or verify your own domain in Resend and set `RESEND_FROM`).
- **Locked out and email reset isn't working?** Set `RESET_PASSWORD` on the server to a temporary password, log in with it (with your account email), choose a new password, then **delete `RESET_PASSWORD`**. While it's set, Settings → Security shows a red warning.
- **Security:** logins last 30 days by default (1, 7, 30 or 90 days in Settings → Security). "Log out all other devices" and a recent-activity list are there too. After 10 wrong passwords from the same IP, login locks for 15 minutes.
- `AUTH_SECRET` (32+ random characters) signs logins **and** encrypts saved WhatsApp tokens. Set it once and don't change it; if you do, everyone is logged out and each saved WhatsApp token must be pasted again.

Secrets belong only in `backend/.env`. `frontend/.env` holds just `REACT_APP_BACKEND_URL`: anything prefixed `REACT_APP_` is baked into the public JavaScript bundle. Both `.env` files are git-ignored.

## 3. Deploy (GitHub, then Render, then Vercel)

Push the repo to GitHub first; both Render and Vercel deploy from it and redeploy on every push.

**Backend on Render**

1. In Render, choose **New → Blueprint**, pick the repo, and Render reads `render.yaml`. It creates `charm-studio-api`, a Python web service on the **free** plan (`plan: free`) running `uvicorn server:app --host 0.0.0.0 --port $PORT`.

   If Render still asks for payment details, create the service by hand instead, without a Blueprint: **New → Web Service**, pick the repo, then set:
   - Root Directory: `backend`
   - Runtime: Python
   - Build Command: `pip install -r requirements.txt`
   - Start Command: `uvicorn server:app --host 0.0.0.0 --port $PORT`
   - Instance Type: **Free**
   - Health Check Path: `/api/health`
   - Environment variables: the ones listed in `render.yaml`, plus `PYTHON_VERSION=3.11.9` and an `AUTH_SECRET` you generate yourself (`python -c "import secrets; print(secrets.token_urlsafe(48))"`)
2. Fill in the secrets Render asks for: `DATABASE_URL`, `ADMIN_PASSWORD` (for your first login; `AUTH_SECRET` is generated for you), the AI key (`ANTHROPIC_API_KEY`, or `OLLAMA_API_KEY` + `OLLAMA_MODEL` with `AI_PROVIDER=ollama`), and optionally `RESEND_API_KEY`. Leave `CORS_ORIGINS` and `FRONTEND_URL` for now.
3. `WA_VERIFY_TOKEN` is generated for you. Copy its value from the service's Environment tab into the Meta console.
4. Note the API URL, e.g. `https://charm-studio-api.onrender.com`, and check `https://…/api/health` returns `{"ok":true}`.

**Frontend on Vercel**

1. In Vercel, choose **Add New → Project**, import the repo, and set **Root Directory** to `frontend`. `frontend/vercel.json` already sets the build and the SPA rewrite, so refreshing `/orders` won't 404.
2. Add the environment variable `REACT_APP_BACKEND_URL` = your Render API URL (no trailing slash), then deploy. CRA bakes it in at build time, so redeploy after changing it.
3. Note the Vercel URL (this project's is `https://charm-studio-silk.vercel.app`; plain `charm-studio.vercel.app` belongs to someone else).

**Connect them:** in Render, set `CORS_ORIGINS` and `FRONTEND_URL` to the Vercel URL. To also allow Vercel preview deployments, set `CORS_ORIGIN_REGEX`, e.g. `https://charm-studio-.*\.vercel\.app`. Render redeploys automatically after you save environment changes.

**Free-plan note:** Render free web services sleep after about 15 minutes idle. The first WhatsApp message after a sleep can take around 30–60 s while the service wakes up. Meta retries webhooks and replies are deduplicated, so nothing is lost, but customers may see a delayed first reply. A paid instance avoids this.

## 4. WhatsApp bot (Meta Cloud API)

1. developers.facebook.com → create a **Business** app → add **WhatsApp**.
2. Copy the **Phone Number ID** and a permanent **access token** (System User in Business Settings), then add them in the app: **Settings → WhatsApp numbers → Add number**. The app checks them with Meta and stores the token encrypted.
3. WhatsApp → Configuration → Webhook:
   - Callback URL: `https://<your-api>.onrender.com/api/wa/webhook` (the WhatsApp Bot page shows it with a copy button)
   - Verify token: the same value as `WA_VERIFY_TOKEN`
4. Subscribe to the **messages** webhook field.

Multiple numbers: add each one in Settings. Incoming messages are routed by `phone_number_id`; **Pause** makes the bot ignore a number without deleting it. Numbers set the old way (`WA_NUMBERS` + `WA_<ID>_*` env vars) are imported into Settings once, on the first start of this version.

The bot's wording (greeting, each question, thank-you message with `{shop_name}`, `{order_id}`, `{name}`, `{charm}`, `{notes}`) is edited in **Settings → Shop & bot**.

**Local testing:** Meta needs public HTTPS. Run `ngrok http 8001` and use `https://<ngrok-id>.ngrok-free.app/api/wa/webhook` with the same verify token.

Bot modes are picked per number when you add or edit it. Meta numbers default to **Ask questions**, 360dialog numbers to **Read only**.

**Ask questions** flow: it asks for Order ID, then name to print, then charm, then notes ("none" skips notes). If a message has 6 or more words, the AI extracts every field it can from it and the bot skips the steps already answered. Sending `hi`, `hello`, `start`, `reset` or `restart` starts over. When all four answers are in, the order is saved with `source=whatsapp`.

### WhatsApp through 360dialog (coexistence)

Use this when the number is also used in the WhatsApp Business phone app, so the team keeps chatting on the phone while Charm.Studio reads the chats and lets staff reply from the browser.

1. Sign up at 360dialog and connect the number with **coexistence** (scan the QR code from the WhatsApp Business app). This keeps the phone app working.
2. In the 360dialog Hub, create an **API key** for that number.
3. In Charm.Studio: **Settings → WhatsApp numbers → Add number → 360dialog**. Enter the number with country code (e.g. `918339039324`) and the API key, and keep the bot on **Read only**.
4. The app points the number's webhook at itself automatically (`/api/wa/webhook/n/<id>/<secret>`). The card's "Copy webhook URL" is only needed if you ever set it by hand.

360dialog doesn't sign webhooks, so each number gets its own unguessable webhook URL instead. The bot waits `READ_DEBOUNCE_SECONDS` (default 20) after a customer's last message before reading the chat, so a customer typing in several short messages costs one AI call. The waiting read is stored in the database, so a restart or deploy doesn't lose it: it runs as soon as the app is back. Without an AI key it still saves order IDs it finds by pattern. It never overwrites fields staff have edited.

**AI cost:** for reading chats, Claude Haiku is the cheapest option that works well. Set `ANTHROPIC_MODEL=claude-haiku-5-5` on Render. At roughly 1,500 messages a day this costs about ₹10 a day. WhatsApp Extract (bulk chat files) uses its own model, `ANTHROPIC_EXTRACT_MODEL` (default `claude-sonnet-5-5`), because long chats with corrections and several orders are where a stronger model pays off. `ANTHROPIC_EXTRACT_EFFORT` (`low` to `max`, blank = model default) sets how hard it thinks: Haiku at `high` costs roughly a fifteenth of Sonnet, so run `tests/test_ai_live.py` (below) to compare accuracy and cost before choosing.

### Order confirmations and other templates

WhatsApp only allows typed replies within 24 hours of the customer's last message. After that (for example, an order confirmation a few days later), you must send a **template**: a message Meta has approved in advance, with blanks like `{{1}}` that are filled in per customer. Meta charges a small fee for each one.

1. Create the template in Meta's **WhatsApp Manager** (or the 360dialog Hub for 360dialog numbers). Choose category **Utility** for order updates, e.g. *Hi {{1}}, your order {{2}} with the name "{{3}}" and {{4}} charm is confirmed.* Wait for approval.
2. Meta numbers only: in **Settings → WhatsApp numbers → Edit**, fill in the **WhatsApp Business Account ID** (WhatsApp Manager shows it). 360dialog numbers need nothing extra.
3. Send it from **Orders** (the paper-plane button on an order with a phone number), from an order card in **Chats** ("Send confirmation"), or from a chat with the **Send template** button.
4. Pick which order field fills each blank (customer name, order ID, name on product, charm, notes, shop name). Charm.Studio remembers the choice per template, and remembers which template "Send confirmation" uses.

Templates with image/video/document headers or link buttons that contain a variable are listed but can't be sent from Charm.Studio yet.

**Replying after 24 hours (late replies).** Create a Utility template with a blank for the staff's own text, for example:

```
Hi {{1}}, here is an update about your order {{2}}:

{{3}}

Reply to this message if you have any questions. Thank you for shopping with Celed Hub!
```

(Meta rejects templates that start or end with a blank, or that are mostly blanks, so keep fixed text around `{{3}}`.) Once it's approved, open **Settings → Templates**, pick it, set the blanks to *Customer name*, *Order ID* and *Your message*, tick **Use for replies after 24 hours** and click **Save** (no chat needed; the same choice is also available from **Send template** in a chat). From then on, when a chat's window has closed, staff just type in the reply box and Charm.Studio sends it with that template (a small Meta fee each). If the customer has no order ID saved, it says so instead of sending; a missing WhatsApp name becomes "there". Photos and files still need an open window. Use it only for order-related messages: promotional text in a Utility template breaks Meta's rules.

## API summary

| Method | Path | Purpose |
|---|---|---|
| POST/GET | `/api/orders` | create / list (`?q=` search) |
| PATCH/DELETE | `/api/orders/{id}` | update / delete one |
| DELETE | `/api/orders` | delete all |
| POST | `/api/orders/bulk` | bulk insert |
| GET | `/api/orders` filters | `q`, `phone`, `order_id`, `start`/`end` (ISO times) and `tz` (minutes); all optional and combined |
| GET | `/api/orders/export.csv` | CSV export (same filters; includes `order_date`) |
| GET | `/api/stats` | dashboard numbers |
| POST | `/api/extract` | AI extract from pasted text |
| POST | `/api/extract/bulk-file` | AI extract from exported chat `.txt` (chunked, deduped) |
| POST | `/api/pdf/analyze` | detect IDs and matches per page, with thumbnails |
| POST | `/api/pdf/annotate` | stamped PDF; `X-Matched-Pages` / `X-Not-Found-Pages` headers |
| GET/POST | `/api/wa/webhook` | Meta verification / incoming messages |
| POST | `/api/wa/webhook/n/{id}/{key}` | incoming messages for one number (360dialog) |
| GET | `/api/inbox/conversations` | chat list (`?q=` searches phone, name, order ID, message text; `?number=`) |
| GET | `/api/inbox/conversations/{number}/{phone}` | one chat: messages, contact, orders; marks it read |
| POST | `/api/inbox/conversations/{number}/{phone}/read-orders` | have the bot read the chat again now |
| POST | `/api/inbox/send` | staff reply; after 24 hours it's sent with the late-reply template if one is set up (`sent_as_template` in the response), otherwise 409 |
| GET | `/api/inbox/media/{message_id}` | the photo/voice note/file on a message (fetched from WhatsApp, cached briefly) |
| POST | `/api/inbox/send-media` | staff send a file (multipart: `number_label`, `to`, `caption`, `file`); same 24-hour rule |
| GET | `/api/inbox/unread` | unread chat count for the nav badge |
| GET | `/api/inbox/templates?number=` | the number's templates (`refresh=true` reloads from WhatsApp) and the remembered settings |
| POST | `/api/inbox/send-template` | send an approved template (any time); `order_id` marks that order confirmed |
| PUT | `/api/settings/templates` | which template "Send confirmation" and late replies use, and which field fills each blank |
| GET | `/api/orders/sheet.pdf` | order sheet PDF grouped by order date (`start`/`end` up to 93 days, and/or `phone`, `order_id`; `tz`, `title`) |
| GET | `/api/wa/status`, `/api/wa/numbers`, `/api/wa/conversations` | bot status |
| POST | `/api/wa/test-send` | send a test message |
| GET | `/api/health` | health check (used by Render) |
| GET | `/api/auth/config` | what the login screen should show (public) |
| POST | `/api/auth/login` | email + password -> bearer token (public) |
| POST | `/api/auth/forgot`, `/api/auth/reset` | email a reset link / set a new password with it (public) |
| GET | `/api/auth/me` | current account and token scope |
| POST | `/api/account/setup` | first-login setup (name, email, password) |
| POST | `/api/account/password` | change password (returns a fresh token) |
| GET/PUT | `/api/account`, `/api/account/profile`, `/api/account/session` | profile, email, login length |
| POST/GET | `/api/account/logout-others`, `/api/account/logins` | log out other devices / recent activity |
| GET/POST | `/api/wa/numbers` | list / add WhatsApp numbers |
| PATCH/DELETE | `/api/wa/numbers/{id}` | edit, pause/resume, replace token / delete |
| POST | `/api/wa/numbers/{id}/check` | check a number with Meta or 360dialog |
| GET/PUT | `/api/settings`, `/api/settings/{shop,bot,labels}` | app settings |
| GET | `/api/system/status` | email, AI, WhatsApp setup status |

Every route needs `Authorization: Bearer <token>` except `/api/health`, `/api/auth/config`, `/api/auth/login`, `/api/auth/forgot`, `/api/auth/reset` and the WhatsApp webhooks (`GET`/`POST /api/wa/webhook` and `POST /api/wa/webhook/n/...`), which Meta and 360dialog must be able to reach. Tokens from the first login or from `RESET_PASSWORD` only allow finishing setup or choosing a new password.

## Tests

`backend/tests/test_account_and_settings.py` runs the real app against a throwaway `charm_test` schema in the database from `backend/.env` (your real tables aren't touched), with Meta and Resend faked:

```bash
cd backend
.venv/Scripts/python.exe tests/test_account_and_settings.py
```

`backend/tests/test_inbox.py` does the same for Chats in a `charm_test_inbox` schema: webhooks (Meta and 360dialog), phone-app echoes, delivery statuses, the read-only bot, search, staff replies, the 24-hour window the order sheet and deleting a chat. 360dialog is faked. `tests/test_askbot.py` checks the Ask questions bot and `tests/test_token_errors.py` the plain-language token errors and the Check button's sending-permission test (no database needed for either).

```bash
cd backend
.venv/Scripts/python.exe tests/test_inbox.py
```

`backend/tests/test_templates.py` covers templates in a `charm_test_templates` schema: loading and checking templates (positional and named blanks, unapproved, image headers, link buttons), the WhatsApp Business Account ID for Meta numbers, sending after the 24-hour window, marking orders confirmed, errors from WhatsApp, and the remembered settings.

```bash
cd backend
.venv/Scripts/python.exe tests/test_templates.py
```

`backend/tests/test_media.py` covers photos, voice notes and files (`charm_test_media` schema): receiving them, showing them for both 360dialog and Meta numbers, expired files, phone-app echoes, sending files, size and type limits and the 24-hour rule. WhatsApp is replaced by a fake HTTP transport, so the real download/upload code runs.

```bash
cd backend
.venv/Scripts/python.exe tests/test_media.py
```

`backend/tests/test_labels.py` checks label reading and the print layout with made-up labels shaped like the real Meesho, Flipkart and courier ones (no database needed): order IDs vs SKU/AWB numbers, order dates, the box below each label on A4 pages, 4-per-sheet small labels and the fallbacks.

`backend/tests/test_order_filters.py` covers the date, phone and order ID filters, order dates (formats, chat, label PDFs, never overwritten), the grouped order sheet, filtered CSV export and the bot keeping the customer's phone.

`backend/tests/test_reads.py` stops and restarts the app while a chat read is waiting and checks it still happens (exactly once), that a burst of messages is read once, and that a failed read is retried.

```bash
cd backend
.venv/Scripts/python.exe tests/test_reads.py
```

`backend/tests/test_ai_models.py` checks which model each AI job uses and which options it sends (no real AI calls). `backend/tests/test_ai_live.py` makes **real, billed** calls (a few cents) with the key in `backend/.env`, running tricky sample chats (Hinglish, corrections, two orders in one chat, no order) through Haiku at low effort, Haiku at high effort and Sonnet, and printing how many fields each got right and what the calls cost; it skips itself when no key is set.

```bash
cd backend
.venv/Scripts/python.exe tests/test_ai_models.py
.venv/Scripts/python.exe tests/test_ai_live.py
```

## Notes

- **AI provider** (`AI_PROVIDER`):
  - `anthropic` (default): `claude-sonnet-5-5` with server-side refusal fallbacks turned on (`fallbacks: "default"`). Set `ANTHROPIC_MODEL` for the WhatsApp bots (`claude-haiku-5-5` is the cheapest choice for reading chats) and `ANTHROPIC_EXTRACT_MODEL` for WhatsApp Extract (default `claude-sonnet-5-5`). Fallbacks are only sent to models that support them (not Haiku). The key comes from platform.claude.com and is billed separately from a Claude Pro subscription.
  - `ollama`: Ollama's Anthropic-compatible endpoint. Set `OLLAMA_API_KEY` and `OLLAMA_MODEL`. `OLLAMA_BASE_URL` defaults to Ollama Cloud (`https://ollama.com`); point it at `http://localhost:11434` for a local server, which needs no key. Open models can be less consistent at returning clean JSON, so review the preview table before saving.
- **Media in Chats:** WhatsApp keeps customers' files for about 30 days. Charm.Studio stores only the file's id and fetches it when someone opens the chat, so older photos show "no longer available". Download anything you need to keep. Sending limits: photos (JPG/PNG) 5 MB; videos, audio and documents (PDF, Word, Excel, PowerPoint, text) 16 MB.
- Stickers use Helvetica (a built-in PDF font). It cannot draw non-Latin scripts such as Devanagari, so write those names in Latin letters.
- Order matching: IDs are compared after removing non-alphanumerics and uppercasing. Two IDs match if they are equal, or if the shorter one is at least 8 characters long and shares an 8-character run with the longer one.
