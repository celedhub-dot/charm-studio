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
