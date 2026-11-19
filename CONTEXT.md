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
- A new feature shouldn't need a new service. The backend is one process: the app is in `server.py`, and crypto helpers live in `security.py` (no app imports, easy to audit).

**Auth**
- Every new backend route goes on the `api` router (full login required). `public` is only for routes an outsider must reach without logging in (the webhook, login, forgot and reset). `session` is only for routes a setup or forced-password-change token may use.
- Never return secrets from the API. WhatsApp tokens are encrypted with `secret_box`, and responses show only their last 4 characters.
- After changing `account`, `app_settings` or `wa_numbers`, reload the matching in-memory cache (`update_account`, `load_settings`, `load_wa_numbers`).
- Test backend changes with `backend/tests/test_account_and_settings.py`. It uses `DB_SCHEMA=charm_test`, because local and production share the same Supabase database.
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
| 2026-11-18 | **Settings page and a real owner account** (seller's answers to a design questionnaire): one owner (not staff accounts); **email + password** login; password stored as a scrypt hash in the database; `ADMIN_PASSWORD` used only for the first login, then setup asks for name, email and a new password. | The seller wanted to change their name and password in the app. A single owner keeps it simple for a one-person shop. |
| 2026-11-18 | **Forgot password by email through Resend**, plus an emergency `RESET_PASSWORD` env backup (forces choosing a new password). | Seller chose email reset; the backup avoids permanent lock-out if email breaks. Resend's test sender works without domain setup for the owner's own address. |
| 2026-11-18 | **WhatsApp numbers managed in Settings**, tokens **AES-GCM encrypted in the database** (key derived from `AUTH_SECRET`), with Pause and Delete. Legacy `WA_*` env numbers are imported once (flag `wa_env_imported`). | Seller wanted to add and remove numbers without editing Render. Encryption keeps tokens unreadable in the database. Adds the `cryptography` dependency. |
| 2026-11-18 | Settings also covers: shop name, bot message wording (one set, any language, placeholders like `{shop_name}`), Label Studio defaults, and security (session length 1/7/30/90 days, log out other devices, recent activity, system status). AI keys stay in Render (status only). | Seller's picks. Keeping AI keys out of the database means fewer stored secrets. |
| 2026-11-18 | Added optional `DB_SCHEMA` and an end-to-end test suite that runs in a throwaway schema. | Local and production share one Supabase database, so tests must never touch the real tables. |

## Current status (2026-11-19)

**Done and verified locally:**
- The backend connects to the real Supabase project: tables are created, and order create, search and delete work.
- The PDF analyze and annotate flow works end to end (matched, not-found and no-ID pages, stickers, count headers).
- Helper functions pass offline checks: ID detection, matching, chunking, dedupe, JSON parsing, bot steps.
- Both AI providers send correctly shaped requests (tested against a local fake API, with no real AI calls made).
- The frontend's production build compiles with no warnings.
- Login works end to end: wrong password, right password, protected routes, tampered and expired tokens, lockout, logout, and a stale saved token.
- The live site runs on Vercel (`charm-studio-silk.vercel.app`) and Render (`charm-studio-api.onrender.com`, free plan, Singapore), with CORS set up.
- The Settings and account features pass 72 automated backend checks (setup, login, password change, email change, log out others, email reset, emergency reset, WhatsApp numbers with encryption, bot wording, label defaults, restart persistence). They were also clicked through in the browser against a throwaway schema.
- The code is pushed to GitHub (`main`).
- Chats (team inbox), 360dialog numbers, bot modes, `customer_phone` on orders and the order sheet PDF pass 33 automated checks (`tests/test_inbox.py`) and were clicked through in the browser with simulated 360dialog webhooks on the local `charm_dev` schema.

**Not yet done or verified:**
- The Settings and account version isn't deployed yet. On first deploy, the owner must log in once with Render's `ADMIN_PASSWORD` and complete account setup.
- Resend isn't configured yet (`RESEND_API_KEY`, `FRONTEND_URL`), so "Forgot password?" shows the `RESET_PASSWORD` instructions instead.
- No real AI call has been made yet: no `ANTHROPIC_API_KEY` or Ollama key is configured.
- The WhatsApp bot hasn't been tested against a real Meta or 360dialog number yet (none added).
- The main number 83390 39324 had a temporary WhatsApp restriction (several staff on WhatsApp Web). Plan: once it lifts, connect it to 360dialog with coexistence and add it in Settings as a 360dialog number in Read-only mode, so staff chat in Charm.Studio instead of WhatsApp Web.
- Photos, voice notes and files in Chats pass 23 automated checks (`tests/test_media.py`) and were clicked through against a local fake 360dialog (photo with caption shown, PDF card, staff photo sent with caption).
- Late replies (typed replies after 24 hours sent as an order-update template) pass the automated checks in `tests/test_templates.py` (52 total). The reply-box and dialog changes compile but weren't clicked through in a browser.
- Templates (order confirmations after the 24-hour window) pass 41 automated checks (`tests/test_templates.py`) and were clicked through against a local fake 360dialog. No real template has been sent yet: one must first be created and approved in WhatsApp Manager or the 360dialog Hub.
- No real Meesho or Flipkart label PDF has been tried yet; only generated test PDFs.

## Open items, roughly by priority

1. **Rotate the Supabase database password** (it was exposed in a chat log during setup), then update `backend/.env` and Render.
2. Deploy the Settings version, complete account setup on the live site, then add `RESEND_API_KEY` and `FRONTEND_URL` on Render and test "Forgot password?".
3. **Verify Meta's `X-Hub-Signature-256`** on the webhook (needs the Meta App Secret as a new env var).
4. Connect 83390 39324 through 360dialog (coexistence), add it in Settings in Read-only mode, set `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL=claude-haiku-5-5` on Render, and test Chats end to end.
4a. Create the `order_update` late-reply template (see README) and set it up with "Use for replies after 24 hours".
4a. Create an order-confirmation template (category Utility) and get it approved; for Meta numbers, enter the WhatsApp Business Account ID in Settings.
4b. +91 94556 58565 has no WhatsApp account, so it can go straight on Meta's Cloud API (no 360dialog needed): wait for the display name "Celed Hub Charms" to be approved, register it, then add it in Settings as a Meta number with WABA ID 1658055335961404. Never install the WhatsApp app on it afterwards.
5. Test with real label PDFs from both marketplaces. Check sticker placement, rotated pages and ID detection.
6. Housekeeping: prune old `wa_events` rows; consider making webhook handling durable.

## Local development environment (seller's Windows PC)

These details are specific to this machine and aren't needed elsewhere.

- **Python 3.15** is installed at `%LOCALAPPDATA%\Programs\Python\Python315` and is *not* on PATH. The backend uses its own isolated environment at `backend/.venv`; run it with `backend\.venv\Scripts\python.exe -m uvicorn server:app --reload --port 8001` from `backend/`.
- **Node 26** is installed at `C:\Program Files\nodejs` and is also not on PATH in every shell. Use **npm** (yarn isn't installed); `package-lock.json` is committed.
- `frontend/.env` sets `BROWSER=none` so `npm start` doesn't open a browser window.
- `.claude/launch.json` (git-ignored) defines the `frontend` and `backend` dev servers for the Claude Code desktop app.
- The GitHub CLI (`gh`) isn't installed. Pushes go over HTTPS with Git Credential Manager.
