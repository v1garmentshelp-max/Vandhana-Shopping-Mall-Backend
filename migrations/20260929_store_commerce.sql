BEGIN;
CREATE TABLE IF NOT EXISTS storefront_cancellations (
  sale_id uuid PRIMARY KEY REFERENCES sales(id),
  user_id bigint REFERENCES vandana_users(id),
  reason text NOT NULL,
  source text NOT NULL DEFAULT 'CUSTOMER' CHECK (source IN ('CUSTOMER','ADMIN')),
  requested_by bigint,
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','REVIEW_REQUIRED','COMPLETED','REJECTED')),
  carrier_attempted boolean NOT NULL DEFAULT false,
  refund_amount_paise bigint NOT NULL DEFAULT 0 CHECK (refund_amount_paise >= 0),
  refund_points integer NOT NULL DEFAULT 0 CHECK (refund_points >= 0),
  excluded_fees_paise bigint NOT NULL DEFAULT 0 CHECK (excluded_fees_paise >= 0),
  refund_status text NOT NULL DEFAULT 'NOT_DUE' CHECK (refund_status IN ('NOT_DUE','PENDING_REFUND','REFUNDED')),
  refund_reference text UNIQUE,
  processed_by bigint,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS storefront_cancellations_open ON storefront_cancellations(status,created_at);
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS bank_upi text;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS reverse_pickup_attempted boolean NOT NULL DEFAULT false;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS reverse_pickup_error text;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS refund_amount_paise bigint;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS refund_points integer;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS excluded_fees_paise bigint;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS refund_reference text;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS refund_received_at timestamptz;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS refund_processed_by bigint;
ALTER TABLE return_items ADD COLUMN IF NOT EXISTS refund_cash_paise bigint;
ALTER TABLE return_items ADD COLUMN IF NOT EXISTS refund_points integer;
CREATE UNIQUE INDEX IF NOT EXISTS return_requests_refund_reference ON return_requests(refund_reference) WHERE refund_reference IS NOT NULL;
COMMIT;
