BEGIN;
CREATE TABLE IF NOT EXISTS mobile_checkouts (
  request_key uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES vandana_users(id),
  sale_id uuid NOT NULL UNIQUE REFERENCES sales(id),
  fingerprint text NOT NULL,
  request_hash text NOT NULL,
  quote jsonb NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0),
  gateway_order_id text UNIQUE,
  gateway_state text NOT NULL DEFAULT 'NEW',
  gateway_payment_id text UNIQUE,
  cart_cleared boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mobile_checkouts_user ON mobile_checkouts(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS mobile_account_requests (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES vandana_users(id),
  type text NOT NULL CHECK (type IN ('DELETE_ACCOUNT')),
  status text NOT NULL DEFAULT 'REQUESTED',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mobile_account_request_open ON mobile_account_requests(user_id, type) WHERE status='REQUESTED';
COMMIT;
