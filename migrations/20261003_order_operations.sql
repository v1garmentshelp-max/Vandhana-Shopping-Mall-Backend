BEGIN;
-- Some older installations use enums for these columns.
DO $$
DECLARE target record; val text;
BEGIN
  FOR target IN SELECT n.nspname,t.typname,a.attname,c.relname
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_type t ON t.oid=a.atttypid
    JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE c.oid IN (to_regclass('sales'),to_regclass('return_requests')) AND t.typtype='e'
    AND a.attname IN ('status','payment_status')
  LOOP
    FOR val IN SELECT unnest(CASE WHEN target.attname='payment_status' THEN ARRAY['PARTIALLY_REFUNDED','REFUNDED']
      WHEN target.relname='return_requests' THEN ARRAY['RECEIVED'] ELSE ARRAY['RTO'] END)
    LOOP EXECUTE format('ALTER TYPE %I.%I ADD VALUE IF NOT EXISTS %L',target.nspname,target.typname,val); END LOOP;
  END LOOP;
END $$;
-- Extend simple legacy status checks while keeping their existing allowed states.
DO $$
DECLARE target record; states text[]; expression text;
BEGIN
  FOR target IN SELECT c.oid,c.relname,a.attname,k.conname,pg_get_expr(k.conbin,k.conrelid) AS definition
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    JOIN pg_attribute a ON a.attrelid=c.oid AND k.conkey=ARRAY[a.attnum]::smallint[]
    WHERE k.contype='c' AND c.oid IN (to_regclass('sales'),to_regclass('return_requests'))
      AND a.attname IN ('status','payment_status')
  LOOP
    states:=CASE WHEN target.attname='payment_status' THEN ARRAY['PARTIALLY_REFUNDED','REFUNDED']
      WHEN target.relname='return_requests' THEN ARRAY['RECEIVED'] ELSE ARRAY['RTO'] END;
    IF EXISTS(SELECT 1 FROM unnest(states) val WHERE position(quote_literal(val) IN target.definition)=0) THEN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',target.oid::regclass,target.conname);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%I::text=ANY(%L::text[]) OR (%s))',
        target.oid::regclass,target.conname,target.attname,states,target.definition);
    END IF;
  END LOOP;
END $$;
CREATE TABLE IF NOT EXISTS order_events (
  id bigserial PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES sales(id),
  event_type text NOT NULL,
  source text NOT NULL,
  reference text,
  status text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_events_sale_time ON order_events(sale_id,occurred_at,id);

CREATE TABLE IF NOT EXISTS order_refund_operations (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES sales(id),
  kind text NOT NULL CHECK (kind IN ('CANCELLATION','RETURN')),
  request_id text NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0),
  payment_id text,
  idempotency_key text UNIQUE NOT NULL,
  provider text NOT NULL CHECK (provider IN ('RAZORPAY','MANUAL','REWARDS')),
  status text NOT NULL CHECK (status IN ('REQUESTED','PENDING','PROCESSED','FAILED','REVIEW_REQUIRED')),
  provider_refund_id text UNIQUE,
  last_error text,
  initiated_by bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE(kind,request_id)
);
CREATE INDEX IF NOT EXISTS order_refund_operations_queue ON order_refund_operations(status,created_at);
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS items_received_at timestamptz;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS received_by bigint;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS inspection_notes text;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS inventory_restocked_at timestamptz;
ALTER TABLE storefront_cancellations ADD COLUMN IF NOT EXISTS refund_received_at timestamptz;
ALTER TABLE storefront_cancellations ADD COLUMN IF NOT EXISTS refund_processed_by bigint;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS carrier_event_at timestamptz;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS shiprocket_order_id text;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS shiprocket_shipment_id text;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS raw_status text;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS tracking_url text;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS label_url text;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS current_location text;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS status_synced_at timestamptz;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS last_tracking_payload jsonb;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS awb_assigned_at timestamptz;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
CREATE TABLE IF NOT EXISTS reverse_shipments (
  id bigserial PRIMARY KEY,request_id bigint NOT NULL REFERENCES return_requests(id),
  shiprocket_order_id text,shiprocket_shipment_id text,awb text,label_url text,tracking_url text,
  status text NOT NULL DEFAULT 'CREATED',created_at timestamptz DEFAULT now()
);
ALTER TABLE reverse_shipments ADD COLUMN IF NOT EXISTS shiprocket_order_id text;
ALTER TABLE reverse_shipments ADD COLUMN IF NOT EXISTS shiprocket_shipment_id text;
ALTER TABLE reverse_shipments ADD COLUMN IF NOT EXISTS awb text;
ALTER TABLE reverse_shipments ADD COLUMN IF NOT EXISTS label_url text;
ALTER TABLE reverse_shipments ADD COLUMN IF NOT EXISTS tracking_url text;
ALTER TABLE reverse_shipments ADD COLUMN IF NOT EXISTS status text DEFAULT 'CREATED';
ALTER TABLE reverse_shipments ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE reverse_shipments ADD COLUMN IF NOT EXISTS awb_attempted boolean NOT NULL DEFAULT false;
ALTER TABLE reverse_shipments ADD COLUMN IF NOT EXISTS pickup_attempted boolean NOT NULL DEFAULT false;
ALTER TABLE reverse_shipments ADD COLUMN IF NOT EXISTS pickup_requested_at timestamptz;
ALTER TABLE reverse_shipments ADD COLUMN IF NOT EXISTS status_synced_at timestamptz;
ALTER TABLE reverse_shipments ADD COLUMN IF NOT EXISTS carrier_event_at timestamptz;
ALTER TABLE reverse_shipments ADD COLUMN IF NOT EXISTS last_tracking_payload jsonb;
ALTER TABLE reverse_shipments ADD COLUMN IF NOT EXISTS last_error text;

-- A database audit follows every writer, including legacy admin endpoints.
CREATE OR REPLACE FUNCTION record_order_operation_event() RETURNS trigger AS $$
DECLARE
  row_data jsonb := to_jsonb(NEW);
  old_data jsonb := CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  sale_ref uuid;
  label text;
  extra jsonb;
BEGIN
  sale_ref := CASE WHEN TG_TABLE_NAME='sales' THEN (row_data->>'id')::uuid ELSE (row_data->>'sale_id')::uuid END;
  IF TG_TABLE_NAME='reverse_shipments' THEN SELECT sale_id INTO sale_ref FROM return_requests WHERE id=(row_data->>'request_id')::bigint; END IF;
  IF sale_ref IS NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='sales' THEN
    IF TG_OP='UPDATE' AND row_data->>'status' IS NOT DISTINCT FROM old_data->>'status'
      AND row_data->>'payment_status' IS NOT DISTINCT FROM old_data->>'payment_status' THEN RETURN NEW; END IF;
    label := CASE WHEN TG_OP='INSERT' THEN 'ORDER_PLACED' ELSE 'ORDER_UPDATED' END;
    extra := jsonb_build_object('payment_status',row_data->>'payment_status','previous_status',old_data->>'status');
  ELSIF TG_TABLE_NAME IN ('shipments','reverse_shipments') THEN
    IF TG_OP='UPDATE' AND row_data->>'status' IS NOT DISTINCT FROM old_data->>'status'
      AND row_data->>'raw_status' IS NOT DISTINCT FROM old_data->>'raw_status'
      AND row_data->>'awb' IS NOT DISTINCT FROM old_data->>'awb' THEN RETURN NEW; END IF;
    label := CASE WHEN TG_TABLE_NAME='reverse_shipments' THEN 'RETURN_SHIPMENT_UPDATED' ELSE 'SHIPMENT_UPDATED' END;
    extra := jsonb_build_object('awb',row_data->>'awb','carrier_status',row_data->>'raw_status','location',row_data->>'current_location');
  ELSE
    IF TG_OP='UPDATE' AND row_data->>'status' IS NOT DISTINCT FROM old_data->>'status'
      AND row_data->>'refund_status' IS NOT DISTINCT FROM old_data->>'refund_status'
      AND row_data->>'refund_reference' IS NOT DISTINCT FROM old_data->>'refund_reference'
      AND row_data->>'items_received_at' IS NOT DISTINCT FROM old_data->>'items_received_at' THEN RETURN NEW; END IF;
    label := CASE TG_TABLE_NAME WHEN 'storefront_cancellations' THEN 'CANCELLATION_UPDATED'
      WHEN 'return_requests' THEN 'RETURN_UPDATED' ELSE 'REFUND_UPDATED' END;
    extra := jsonb_build_object('reason',row_data->>'reason','refund_status',row_data->>'refund_status',
      'amount_paise',COALESCE(row_data->>'refund_amount_paise',row_data->>'amount_paise'),
      'reward_points',row_data->>'refund_points','refund_reference',COALESCE(row_data->>'refund_reference',row_data->>'provider_refund_id'),
      'items_received_at',row_data->>'items_received_at','actor_id',COALESCE(row_data->>'refund_processed_by',row_data->>'processed_by',row_data->>'initiated_by'));
  END IF;
  INSERT INTO order_events(sale_id,event_type,source,reference,status,details)
    VALUES(sale_ref,label,TG_TABLE_NAME,COALESCE(row_data->>'id',row_data->>'sale_id'),row_data->>'status',extra);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS order_event_sales ON sales;
CREATE TRIGGER order_event_sales AFTER INSERT OR UPDATE ON sales FOR EACH ROW EXECUTE FUNCTION record_order_operation_event();
DROP TRIGGER IF EXISTS order_event_shipments ON shipments;
CREATE TRIGGER order_event_shipments AFTER INSERT OR UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION record_order_operation_event();
DROP TRIGGER IF EXISTS order_event_cancellations ON storefront_cancellations;
CREATE TRIGGER order_event_cancellations AFTER INSERT OR UPDATE ON storefront_cancellations FOR EACH ROW EXECUTE FUNCTION record_order_operation_event();
DROP TRIGGER IF EXISTS order_event_returns ON return_requests;
CREATE TRIGGER order_event_returns AFTER INSERT OR UPDATE ON return_requests FOR EACH ROW EXECUTE FUNCTION record_order_operation_event();
DROP TRIGGER IF EXISTS order_event_refunds ON order_refund_operations;
CREATE TRIGGER order_event_refunds AFTER INSERT OR UPDATE ON order_refund_operations FOR EACH ROW EXECUTE FUNCTION record_order_operation_event();
DROP TRIGGER IF EXISTS order_event_reverse_shipments ON reverse_shipments;
CREATE TRIGGER order_event_reverse_shipments AFTER INSERT OR UPDATE ON reverse_shipments FOR EACH ROW EXECUTE FUNCTION record_order_operation_event();
COMMIT;
