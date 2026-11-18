# Project context

Background for anyone picking up this codebase, human or AI assistant: who it's for, the domain vocabulary, the rules the code follows, the decisions made so far, and what's still open. How the system works is in [ARCHITECTURE.md](ARCHITECTURE.md); how to run and deploy it is in [README.md](README.md).

## The business

A small, one-person seller in India makes **customised charms** (keychains and similar items with a name and a chosen charm) and sells them through **Meesho** and **Flipkart**.

- Customers place the order on the marketplace, then send their customisation (the name to print, which charm, any notes) to the seller on **WhatsApp**.
- The marketplace produces **A4 PDF shipping labels**, often several labels per PDF, one per page. Each label shows the marketplace order ID and a barcode.
- Before Charm.Studio, the seller had to match each label to the right WhatsApp chat by hand while packing. That was slow and error-prone.

**What Charm.Studio does:** it captures each customisation as a structured order, by hand, from CSV, by AI from chat text, or through a WhatsApp bot. It then stamps that customisation onto the matching page of the label PDF, so the packer sees "Name / Charm / Notes" right on the label.

The user is a non-developer running a small business. Keep the UI plain and forgiving, and use short, everyday wording. Anything that costs money (AI usage, paid hosting) should stay small and predictable.

## Glossary

| Term | Meaning |
|---|---|
| **Order ID** (`order_id`) | The marketplace's ID printed on the label. Meesho uses a sub-order number such as `123456789012_1`; Flipkart uses `OD` followed by 15 or more digits. |
| **Name on product** (`product_name`) | The text to print or engrave on the charm. It is *not* the product's catalogue name. |
| **Charm** | Which charm or design the customer picked. |
| **Notes** | Anything else: colour, gift wrap, font, and so on. |
| **Source** | How an order was created: `manual`, `ai` (extracted from chat text), `csv`, or `whatsapp` (bot). |
| **Channel** | For bot orders, the logical WhatsApp number it came in on (e.g. `main`, `store2`). Empty otherwise. |
| **Logical id** | The short name for a WhatsApp business number in `WA_NUMBERS` (e.g. `main`). The env vars `WA_<ID>_PHONE_ID`, `WA_<ID>_TOKEN`, etc. use it. |
| **Sticker** | The small box drawn in a corner of a label page. Green **CUSTOMISATION** when matched, red **ORDER NOT FOUND** when not. |
| **Override** | A seller's manual choice of which order belongs to a label page, made in Label Studio. |
| **Label Studio** | The page that analyses a label PDF and generates the stamped copy. |

## Conventions the code follows

These came from the original spec. Keep them unless there's a good reason to change.

**Backend**
- Every route is under `/api`.
- Records are identified by a string UUID `id`; database internals are never returned.
- Config comes only from environment variables. No hard-coded URLs or keys anywhere.
- All SQL is parameterized.
- Timestamps are stored in UTC and returned as ISO-8601 strings.
- A new feature shouldn't need a new service. The backend is deliberately one file (`server.py`) and one process.

**Auth**
- Every new backend route goes on the `api` router (login required). Only add a route to `public` when an outside service has to call it without logging in, as Meta does with the webhook.
- Frontend calls must go through the axios client in `src/lib/api.js` so they carry the token. Don't use raw `fetch` or `<a href>` to API URLs.

**Frontend**
- Design is earthy and organic: primary deep green `#2D4A22`, accent terracotta `#D97757`, warm off-white background `#F7F5F0`, subtle borders, rounded cards, small hover animations.
- Fonts are Manrope for headings and IBM Plex Sans for body text.
- **No emojis and no purple gradients.** Icons come from `@phosphor-icons/react` only.
- Every interactive element gets a `data-testid`.
- Components are shadcn-style, hand-written on Radix primitives in `src/components/ui/`. There is no shadcn CLI and no `@/` path alias; imports are relative.
- Notifications use Sonner toasts. Errors go through `errorMessage()` in `src/lib/api.js`.
- AI results and CSV imports always go through an editable preview before saving. Never save unreviewed AI output.

**Secrets**
- Secrets belong only in `backend/.env` (locally) or Render's environment (production).
- `frontend/.env` holds just `REACT_APP_BACKEND_URL`; every `REACT_APP_*` value ends up in the public JavaScript bundle.
- Both `.env` files are git-ignored. The repo is **public**, so nothing secret may be committed.

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-11-18 | Built from the original spec: FastAPI, React (CRA), PyMuPDF, Claude, WhatsApp Cloud API. | Starting point. |
| 2026-11-18 | **MongoDB replaced by Supabase Postgres** (asyncpg, not Motor). Same three collections became tables; `wa_conversations.fields` is `jsonb`. | The seller chose Supabase for the database. |
| 2026-11-18 | Connect through Supabase's **Session pooler**, with asyncpg `statement_cache_size=0`. | Render can't reach Supabase's IPv6-only direct connection. Turning off statement caching also keeps the transaction pooler (PgBouncer) working. |
| 2026-11-18 | Schema runs automatically on startup (`schema.sql`, idempotent), and RLS is enabled with no policies. | No manual migration step for a non-developer. Keeps Supabase's public REST API from exposing orders. |
| 2026-11-18 | AI model is `claude-sonnet-5-5` with server-side refusal fallbacks on. | The spec asked for the latest Sonnet. |
| 2026-11-18 | **`AI_PROVIDER=ollama` option added**, using Ollama's Anthropic-compatible endpoint through the same SDK. | The seller asked about using an Ollama key instead of an Anthropic key. A Claude Pro subscription doesn't include API access. |
| 2026-11-18 | Hosting: **frontend on Vercel, backend on Render, database on Supabase, code on GitHub** (`celedhub-dot/charm-studio`). | The seller's choice. Render's static site was dropped in favour of Vercel. |
| 2026-11-18 | `requirements.txt` uses plain `uvicorn`, not `uvicorn[standard]`. | Local dev runs Python 3.15, and the `[standard]` extras had no 3.15 Windows wheels. Plain uvicorn covers everything the app needs. |
| 2026-11-18 | Sticker text is cut with `...`, not `…`. | Base-14 Helvetica in PyMuPDF renders `…` as `·`. |
| 2026-11-18 | CORS accepts an optional `CORS_ORIGIN_REGEX`. | Vercel preview deployments get a different URL each time. |
| 2026-11-18 | Bot: a short, digit-free first message just triggers the greeting instead of being saved as an Order ID. | Customers often open with "ok" or "hey". |
| 2026-11-18 | **API authentication added:** a single admin password (`ADMIN_PASSWORD`) exchanged for an HMAC-signed, 30-day bearer token (`AUTH_SECRET`). Public routes are only health, login and the WhatsApp webhook. It fails closed when not configured. | One seller, so no user accounts needed. A key baked into the frontend would be public on Vercel, so a real login was required. No new dependencies (stdlib `hmac`). |

## Current status (2026-11-18)

**Done and verified locally:**
- The backend connects to the real Supabase project: tables are created, and order create, search and delete work.
- The PDF analyze and annotate flow works end to end (matched, not-found and no-ID pages, stickers, count headers).
- Helper functions pass offline checks: ID detection, matching, chunking, dedupe, JSON parsing, bot steps.
- Both AI providers send correctly shaped requests (tested against a local fake API, with no real AI calls made).
- The frontend's production build compiles with no warnings.
- Login works end to end: wrong password, right password, protected routes, tampered and expired tokens, lockout, logout, and a stale saved token.
- The code is pushed to GitHub (`main`).

**Not yet done or verified:**
- Render and Vercel deployments haven't been created.
- No real AI call has been made yet: no `ANTHROPIC_API_KEY` or Ollama key is configured.
- The WhatsApp bot hasn't been tested against Meta (no `WA_*` credentials yet).
- No real Meesho or Flipkart label PDF has been tried yet; only generated test PDFs.

## Open items, roughly by priority

1. **Rotate the Supabase database password** (it was exposed in a chat log during setup), then update `backend/.env` and Render.
2. **Verify Meta's `X-Hub-Signature-256`** on the webhook (needs the Meta App Secret as a new env var).
3. Deploy: Render first, then Vercel, then set `CORS_ORIGINS` on Render. Set a strong `ADMIN_PASSWORD` on Render.
4. Test with real label PDFs from both marketplaces. Check sticker placement, rotated pages and ID detection.
5. Housekeeping: prune old `wa_events` rows; consider making webhook handling durable.

## Local development environment (seller's Windows PC)

These details are specific to this machine and aren't needed elsewhere.

- **Python 3.15** is installed at `%LOCALAPPDATA%\Programs\Python\Python315` and is *not* on PATH. The backend uses its own isolated environment at `backend/.venv`; run it with `backend\.venv\Scripts\python.exe -m uvicorn server:app --reload --port 8001` from `backend/`.
- **Node 26** is installed at `C:\Program Files\nodejs` and is also not on PATH in every shell. Use **npm** (yarn isn't installed); `package-lock.json` is committed.
- `frontend/.env` sets `BROWSER=none` so `npm start` doesn't open a browser window.
- `.claude/launch.json` (git-ignored) defines the `frontend` and `backend` dev servers for the Claude Code desktop app.
- The GitHub CLI (`gh`) isn't installed. Pushes go over HTTPS with Git Credential Manager.
