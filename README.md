# Charm.Studio

Charm.Studio is for a small seller who takes customised-charm orders on WhatsApp and ships them through Meesho or Flipkart. It records each customer's customisation (name on product, charm, notes) and stamps it onto the seller's A4 PDF shipping labels by matching Order IDs.

- **Backend:** FastAPI, asyncpg (Supabase Postgres), PyMuPDF, Anthropic SDK (Claude `claude-sonnet-5-5` by default, or Ollama), Meta WhatsApp Cloud API
- **Frontend:** React (CRA), React Router v7, Tailwind CSS, shadcn-style components on Radix, Phosphor Icons, Sonner, axios
- **Hosting:** Vercel (frontend), Render (API) and Supabase (database). Code lives on GitHub.

```
backend/   server.py, schema.sql, requirements.txt, .env.example
frontend/  React app (src/lib/api.js is the axios client), vercel.json
render.yaml  Render Blueprint for the API
```

```
Browser ──> Vercel (React) ──HTTPS──> Render (FastAPI) ──> Supabase (Postgres)
Meta WhatsApp ──webhook──────────────┘        └──> Claude / Ollama API
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
cp .env.example .env        # then fill DATABASE_URL, the AI key, WA_* values
python -m venv .venv && .venv/Scripts/activate   # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt && uvicorn server:app --reload --port 8001
```

Frontend (npm or yarn):

```bash
cd frontend
cp .env.example .env        # REACT_APP_BACKEND_URL=http://localhost:8001
npm install && npm start
```

Secrets belong only in `backend/.env`. `frontend/.env` holds just `REACT_APP_BACKEND_URL`: anything prefixed `REACT_APP_` is baked into the public JavaScript bundle. Both `.env` files are git-ignored.

Open http://localhost:3000.

## 3. Deploy (GitHub, then Render, then Vercel)

Push the repo to GitHub first; both Render and Vercel deploy from it and redeploy on every push.

**Backend on Render**

1. In Render, choose **New → Blueprint**, pick the repo, and Render reads `render.yaml`. It creates `charm-studio-api`, a Python web service (`uvicorn server:app --host 0.0.0.0 --port $PORT`).
2. Fill in the secrets Render asks for: `DATABASE_URL`, the AI key (`ANTHROPIC_API_KEY`, or `OLLAMA_API_KEY` + `OLLAMA_MODEL` with `AI_PROVIDER=ollama`), and the `WA_MAIN_*` values. Leave `CORS_ORIGINS` for now.
3. `WA_VERIFY_TOKEN` is generated for you. Copy its value from the service's Environment tab into the Meta console.
4. Note the API URL, e.g. `https://charm-studio-api.onrender.com`, and check `https://…/api/health` returns `{"ok":true}`.

**Frontend on Vercel**

1. In Vercel, choose **Add New → Project**, import the repo, and set **Root Directory** to `frontend`. `frontend/vercel.json` already sets the build and the SPA rewrite, so refreshing `/orders` won't 404.
2. Add the environment variable `REACT_APP_BACKEND_URL` = your Render API URL (no trailing slash), then deploy. CRA bakes it in at build time, so redeploy after changing it.
3. Note the Vercel URL, e.g. `https://charm-studio.vercel.app`.

**Connect them:** in Render, set `CORS_ORIGINS` to the Vercel URL. To also allow Vercel preview deployments, set `CORS_ORIGIN_REGEX`, e.g. `https://charm-studio-.*\.vercel\.app`. Render redeploys automatically after you save environment changes.

**Free-plan note:** Render free web services sleep after about 15 minutes idle. The first WhatsApp message after a sleep can take around 30–60 s while the service wakes up. Meta retries webhooks and replies are deduplicated, so nothing is lost, but customers may see a delayed first reply. A paid instance avoids this.

## 4. WhatsApp bot (Meta Cloud API)

1. developers.facebook.com → create a **Business** app → add **WhatsApp**.
2. Copy the **Phone Number ID** and a permanent **access token** into `WA_MAIN_PHONE_ID` / `WA_MAIN_TOKEN`.
3. WhatsApp → Configuration → Webhook:
   - Callback URL: `https://<your-api>.onrender.com/api/wa/webhook` (the WhatsApp Bot page shows it with a copy button)
   - Verify token: the same value as `WA_VERIFY_TOKEN`
4. Subscribe to the **messages** webhook field.

Multiple numbers: set `WA_NUMBERS=main,store2` and add `WA_STORE2_PHONE_ID`, `WA_STORE2_TOKEN`, `WA_STORE2_DISPLAY` (and optionally `WA_STORE2_VERIFY`). Incoming messages are routed by `phone_number_id`.

**Local testing:** Meta needs public HTTPS. Run `ngrok http 8001` and use `https://<ngrok-id>.ngrok-free.app/api/wa/webhook` with the same verify token.

Bot flow: it asks for Order ID, then name to print, then charm, then notes ("none" skips notes). If a message has 6 or more words, Claude extracts every field it can from it and the bot skips the steps already answered. Sending `hi`, `hello`, `start`, `reset` or `restart` starts over. When all four answers are in, the order is saved with `source=whatsapp`.

## API summary

| Method | Path | Purpose |
|---|---|---|
| POST/GET | `/api/orders` | create / list (`?q=` search) |
| PATCH/DELETE | `/api/orders/{id}` | update / delete one |
| DELETE | `/api/orders` | delete all |
| POST | `/api/orders/bulk` | bulk insert |
| GET | `/api/orders/export.csv` | CSV export |
| GET | `/api/stats` | dashboard numbers |
| POST | `/api/extract` | AI extract from pasted text |
| POST | `/api/extract/bulk-file` | AI extract from exported chat `.txt` (chunked, deduped) |
| POST | `/api/pdf/analyze` | detect IDs and matches per page, with thumbnails |
| POST | `/api/pdf/annotate` | stamped PDF; `X-Matched-Pages` / `X-Not-Found-Pages` headers |
| GET/POST | `/api/wa/webhook` | Meta verification / incoming messages |
| GET | `/api/wa/status`, `/api/wa/numbers`, `/api/wa/conversations` | bot status |
| POST | `/api/wa/test-send` | send a test message |
| GET | `/api/health` | health check (used by Render) |

## Notes

- **AI provider** (`AI_PROVIDER`):
  - `anthropic` (default): `claude-sonnet-5-5` with server-side refusal fallbacks turned on (`fallbacks: "default"`). Set `ANTHROPIC_MODEL` to use a different model. The key comes from platform.claude.com and is billed separately from a Claude Pro subscription.
  - `ollama`: Ollama's Anthropic-compatible endpoint. Set `OLLAMA_API_KEY` and `OLLAMA_MODEL`. `OLLAMA_BASE_URL` defaults to Ollama Cloud (`https://ollama.com`); point it at `http://localhost:11434` for a local server, which needs no key. Open models can be less consistent at returning clean JSON, so review the preview table before saving.
- Stickers use Helvetica (a built-in PDF font). It cannot draw non-Latin scripts such as Devanagari, so write those names in Latin letters.
- Order matching: IDs are compared after removing non-alphanumerics and uppercasing. Two IDs match if they are equal, or if the shorter one is at least 8 characters long and shares an 8-character run with the longer one.
