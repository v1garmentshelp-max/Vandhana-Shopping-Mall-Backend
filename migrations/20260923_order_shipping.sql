BEGIN;
CREATE TABLE IF NOT EXISTS order_shipping_workflow (
  sale_id uuid PRIMARY KEY REFERENCES sales(id),
  phase text NOT NULL DEFAULT 'LEGACY_UNKNOWN',
  create_attempted boolean NOT NULL DEFAULT false,
  awb_attempted boolean NOT NULL DEFAULT false,
  pickup_attempted boolean NOT NULL DEFAULT false,
  pickup_requested_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
