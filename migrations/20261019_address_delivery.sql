BEGIN;
CREATE TABLE IF NOT EXISTS mobile_addresses (
  id uuid PRIMARY KEY, user_id bigint NOT NULL REFERENCES vandana_users(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'Home', address jsonb NOT NULL, is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mobile_address_default ON mobile_addresses(user_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS mobile_address_owner ON mobile_addresses(user_id,updated_at DESC);
COMMIT;
