require('dotenv').config();
const { policy } = require('../services/commercePolicy');

const fields = {
  order_events: 'id sale_id event_type source reference status details occurred_at',
  order_shipping_workflow: 'sale_id phase create_attempted awb_attempted pickup_attempted pickup_requested_at last_error created_at updated_at',
  reverse_shipments: 'id request_id shiprocket_order_id shiprocket_shipment_id awb label_url tracking_url status created_at awb_attempted pickup_attempted pickup_requested_at status_synced_at carrier_event_at last_tracking_payload last_error',
  order_refund_operations: 'id sale_id kind request_id amount_paise payment_id idempotency_key provider status provider_refund_id last_error initiated_by created_at updated_at processed_at',
  storefront_cancellations: 'sale_id user_id reason source requested_by status carrier_attempted refund_amount_paise refund_points excluded_fees_paise refund_status refund_reference refund_received_at refund_processed_by processed_by last_error created_at updated_at',
  return_requests: 'id sale_id status refund_status refund_amount_paise refund_points excluded_fees_paise refund_reference refund_received_at refund_processed_by bank_upi updated_at reverse_pickup_attempted reverse_pickup_error items_received_at received_by inspection_notes inventory_restocked_at',
  return_items: 'sale_item_id variant_id refund_cash_paise refund_points',
  order_cancellations: 'sale_id payment_type reason cancellation_source created_at',
  reward_point_lots: 'id user_id source_type source_ref points_granted points_remaining created_at updated_at',
  shipments: 'shiprocket_order_id shiprocket_shipment_id delivered_at raw_status tracking_url label_url current_location status_synced_at last_tracking_payload awb_assigned_at updated_at carrier_event_at'
};
const audits = [
  ['sales', 'order_event_sales'],
  ['shipments', 'order_event_shipments'],
  ['storefront_cancellations', 'order_event_cancellations'],
  ['return_requests', 'order_event_returns'],
  ['order_refund_operations', 'order_event_refunds'],
  ['reverse_shipments', 'order_event_reverse_shipments']
];
const quote = value => '"' + value.replaceAll('"', '""') + '"';

async function preflight(db, logger = console) {
  db = db || require('../db');
  const { rows: contexts } = await db.query(`SELECT current_database() AS database,
    current_schema() AS schema, current_user AS role,
    current_setting('search_path') AS search_path,
    current_setting('transaction_read_only') AS read_only`);
  const context = contexts[0];
  logger.log('Commerce database connection:', JSON.stringify(context));

  // Resolve names exactly as the application does. Missing tables never cause
  // a raw 42P01 error here, and a matching table in another schema cannot pass.
  const { rows: tables } = await db.query(`SELECT required.table_name,
      ns.nspname AS resolved_schema, visible.relkind AS table_kind,
      CASE WHEN visible.oid IS NULL THEN false
        ELSE has_table_privilege(visible.oid, 'SELECT') END AS can_select,
      ARRAY(SELECT a.attname::text FROM pg_attribute a
        WHERE a.attrelid=visible.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
      ARRAY(SELECT n.nspname::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relname=required.table_name AND c.relkind IN ('r','p','v','m','f')
        ORDER BY n.nspname) AS found_schemas
    FROM unnest($1::text[]) AS required(table_name)
    LEFT JOIN pg_class visible ON visible.oid=to_regclass(quote_ident(required.table_name))
    LEFT JOIN pg_namespace ns ON ns.oid=visible.relnamespace`, [Object.keys(fields)]);

  const problems = [];
  for (const [table, requiredFields] of Object.entries(fields)) {
    const actual = tables.find(row => row.table_name === table);
    if (!actual || !actual.resolved_schema) {
      const elsewhere = actual?.found_schemas?.length
        ? ` Found in schema(s): ${actual.found_schemas.join(', ')}; check search_path and schema USAGE permission.`
        : ' Not present in this connected database.';
      problems.push(`Missing table: public.${table}.${elsewhere}`);
      continue;
    }
    if (actual.resolved_schema !== 'public') {
      problems.push(`Schema mismatch: ${table} resolves to ${actual.resolved_schema}; this release requires public.${table}.`);
      continue;
    }
    if (!['r', 'p'].includes(actual.table_kind)) problems.push(`public.${table} must be a table.`);
    if (!actual.can_select) problems.push(`Missing SELECT permission: public.${table}.`);
    for (const column of requiredFields.split(' ')) {
      if (!actual.columns.includes(column)) problems.push(`Missing column: public.${table}.${column}.`);
    }
  }

  const { rows: triggers } = await db.query(`SELECT c.relname AS table_name, t.tgname AS trigger_name,
      t.tgenabled AS enabled, p.proname AS function_name, fn.nspname AS function_schema
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace ns ON ns.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace fn ON fn.oid=p.pronamespace
    WHERE ns.nspname='public' AND NOT t.tgisinternal
      AND t.tgname=ANY($1::text[])`, [audits.map(([, name]) => name)]);
  for (const [table, name] of audits) {
    const trigger = triggers.find(row => row.table_name === table && row.trigger_name === name);
    if (!trigger || !['O', 'A'].includes(trigger.enabled) ||
      trigger.function_name !== 'record_order_operation_event' || trigger.function_schema !== 'public') {
      problems.push(`Missing or disabled audit trigger: public.${table}.${name}.`);
    }
  }

  if (context.read_only === 'on') problems.push('The database connection is read-only; order updates require a writable connection.');
  if (problems.length) {
    const error = new Error([
      `Database/schema readiness failed for ${context.database} (search_path: ${context.search_path}).`,
      ...problems,
      'Compare this Vercel project DATABASE_URL host, port and database with the committed DBeaver connection. A PASS from a different server or an uncommitted session does not verify this connection.',
      'If the tables are absent in this exact database, apply the supplied reviewed migration there after a backup. If they exist in public, correct the connection/search_path/permissions. Then redeploy.',
      'This check is read-only. No migrations, refunds, stock or reward changes were performed.'
    ].join('\n'));
    error.code = 'DATABASE_SCHEMA_NOT_READY';
    error.context = context;
    error.problems = problems;
    throw error;
  }

  // Also verify column access without fetching any customer or order records.
  for (const [table, columns] of Object.entries(fields)) {
    await db.query(`SELECT ${columns.split(' ').map(quote).join(',')} FROM public.${quote(table)} LIMIT 0`);
  }
  logger.log('Commerce database preflight passed. Required columns and 6 audit triggers verified. Delivery policy:', JSON.stringify(policy()));
  return context;
}

if (require.main === module) {
  let pool;
  (async () => {
    pool = require('../db');
    await preflight(pool);
  })().catch(error => {
    console.error('Commerce preflight failed:', error.message);
    process.exitCode = 1;
  }).finally(() => pool?.end());
}
module.exports = { preflight };
