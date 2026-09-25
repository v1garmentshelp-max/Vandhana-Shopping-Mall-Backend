BEGIN;
CREATE TABLE IF NOT EXISTS mobile_store_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  config jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO mobile_store_settings(id,config) VALUES(true,'{
  "support":{"email":"support@vandhanashoppingmall.com"},
  "customizer":{"enabled":true,"garments":[{"id":"crew","name":"Crew-neck T-shirt","price":799,"mrp":999,"enabled":true},{"id":"hoodie","name":"Hoodie","price":799,"mrp":999,"enabled":true},{"id":"longsleeve","name":"Long-sleeve T-shirt","price":799,"mrp":999,"enabled":true}],"sizes":["S","M","L","XL","2XL","3XL"],"colors":[{"name":"White","code":"#ffffff"},{"name":"Black","code":"#1a1a1a"},{"name":"Heather Grey","code":"#9ca3af"},{"name":"Navy Blue","code":"#1e3a8a"},{"name":"Red","code":"#dc2626"},{"name":"Forest Green","code":"#166534"}]}
}'::jsonb) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS mobile_addresses (
  id uuid PRIMARY KEY, user_id bigint NOT NULL REFERENCES vandana_users(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'Home', address jsonb NOT NULL, is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mobile_address_default ON mobile_addresses(user_id) WHERE is_default;
CREATE TABLE IF NOT EXISTS mobile_uploads (
  id uuid PRIMARY KEY,user_id bigint NOT NULL REFERENCES vandana_users(id) ON DELETE CASCADE,
  url text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mobile_designs (
  id uuid PRIMARY KEY,user_id bigint NOT NULL REFERENCES vandana_users(id) ON DELETE CASCADE,
  title text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS is_custom boolean NOT NULL DEFAULT false;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS custom_title text;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS custom_payload jsonb;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS is_innerwear boolean NOT NULL DEFAULT false;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE return_items ADD COLUMN IF NOT EXISTS sale_item_id uuid REFERENCES sale_items(id);
ALTER TABLE return_items ALTER COLUMN variant_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS mobile_designs_owner ON mobile_designs(user_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS mobile_uploads_owner ON mobile_uploads(user_id);
COMMIT;
