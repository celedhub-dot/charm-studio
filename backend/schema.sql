-- Charm.Studio schema for Supabase (Postgres).
-- The backend runs this automatically on startup (idempotent). You can also paste it
-- into the Supabase SQL editor once.

CREATE TABLE IF NOT EXISTS orders (
    id           text PRIMARY KEY,
    order_id     text NOT NULL DEFAULT '',
    product_name text NOT NULL DEFAULT '',
    charm        text NOT NULL DEFAULT '',
    notes        text NOT NULL DEFAULT '',
    source       text NOT NULL DEFAULT 'manual',
    channel      text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS orders_source_idx ON orders (source);

CREATE TABLE IF NOT EXISTS wa_conversations (
    business_number_id text NOT NULL,
    customer_phone     text NOT NULL,
    step               int  NOT NULL DEFAULT 0,
    fields             jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_number_id, customer_phone)
);

CREATE TABLE IF NOT EXISTS wa_events (
    message_id  text PRIMARY KEY,
    received_at timestamptz NOT NULL DEFAULT now()
);

-- The owner's account (exactly one row, id = 1). An empty password_hash means
-- first-time setup hasn't happened yet (login falls back to ADMIN_PASSWORD once).
CREATE TABLE IF NOT EXISTS account (
    id                  int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    name                text NOT NULL DEFAULT '',
    email               text NOT NULL DEFAULT '',
    password_hash       text NOT NULL DEFAULT '',
    token_version       int  NOT NULL DEFAULT 1,
    session_days        int  NOT NULL DEFAULT 30,
    password_changed_at timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO account (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Key/value settings (shop profile, bot messages, label defaults, internal flags).
CREATE TABLE IF NOT EXISTS app_settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- WhatsApp business numbers. Access and verify tokens are AES-GCM encrypted.
CREATE TABLE IF NOT EXISTS wa_numbers (
    id               text PRIMARY KEY,
    label            text NOT NULL UNIQUE,
    display          text NOT NULL DEFAULT '',
    phone_id         text NOT NULL UNIQUE,
    token_enc        text NOT NULL,
    token_last4      text NOT NULL DEFAULT '',
    verify_token_enc text NOT NULL DEFAULT '',
    active           boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Recent login attempts, shown on the Security settings tab (kept 90 days).
CREATE TABLE IF NOT EXISTS login_events (
    id         bigserial PRIMARY KEY,
    at         timestamptz NOT NULL DEFAULT now(),
    ip         text NOT NULL DEFAULT '',
    user_agent text NOT NULL DEFAULT '',
    method     text NOT NULL DEFAULT '',
    success    boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS login_events_at_idx ON login_events (at DESC);

-- One-time password reset links (only a SHA-256 hash of each token is stored).
CREATE TABLE IF NOT EXISTS password_resets (
    token_hash text PRIMARY KEY,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Added later: link orders to the customer's WhatsApp number.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS orders_customer_phone_idx ON orders (customer_phone);

-- Added later: how each number connects and how its bot behaves.
--   provider: 'meta' (Phone Number ID + token) or '360dialog' (API key)
--   bot_mode: 'ask' (asks the customer step by step), 'read' (only reads and saves orders), 'off'
--   webhook_key: secret part of the per-number webhook address (360dialog)
ALTER TABLE wa_numbers ADD COLUMN IF NOT EXISTS provider    text NOT NULL DEFAULT 'meta';
ALTER TABLE wa_numbers ADD COLUMN IF NOT EXISTS bot_mode    text NOT NULL DEFAULT 'ask';
ALTER TABLE wa_numbers ADD COLUMN IF NOT EXISTS webhook_key text NOT NULL DEFAULT '';
ALTER TABLE wa_numbers ADD COLUMN IF NOT EXISTS waba_id     text NOT NULL DEFAULT '';  -- Meta: needed to list templates
-- When an order confirmation template was last sent for this order
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

-- Every WhatsApp message in and out (customer, bot, staff, or sent from the phone app).
CREATE TABLE IF NOT EXISTS wa_messages (
    id             text PRIMARY KEY,
    number_label   text NOT NULL,
    customer_phone text NOT NULL,
    direction      text NOT NULL,                 -- 'in' | 'out'
    kind           text NOT NULL DEFAULT 'text',  -- text, image, document, audio, video, sticker, location, ...
    body           text NOT NULL DEFAULT '',
    wa_message_id  text,
    status         text NOT NULL DEFAULT '',      -- received, sent, delivered, read, failed
    source         text NOT NULL DEFAULT '',      -- customer, bot, staff, phone_app
    error          text NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wa_messages_wamid_idx ON wa_messages (wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wa_messages_thread_idx ON wa_messages (number_label, customer_phone, created_at DESC);

-- One row per customer per number: what the Chats list shows.
CREATE TABLE IF NOT EXISTS wa_contacts (
    number_label    text NOT NULL,
    customer_phone  text NOT NULL,
    name            text NOT NULL DEFAULT '',
    last_preview    text NOT NULL DEFAULT '',
    last_message_at timestamptz NOT NULL DEFAULT now(),
    last_inbound_at timestamptz,
    unread          int  NOT NULL DEFAULT 0,
    PRIMARY KEY (number_label, customer_phone)
);
CREATE INDEX IF NOT EXISTS wa_contacts_recent_idx ON wa_contacts (last_message_at DESC);

-- Lock the tables away from Supabase's public REST API (anon/authenticated keys).
-- The backend connects as the table owner, which is not affected by RLS.
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_contacts ENABLE ROW LEVEL SECURITY;
