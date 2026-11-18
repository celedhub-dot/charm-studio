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

-- Lock the tables away from Supabase's public REST API (anon/authenticated keys).
-- The backend connects as the table owner, which is not affected by RLS.
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_events ENABLE ROW LEVEL SECURITY;
