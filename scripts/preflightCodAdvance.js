require('dotenv').config();
const pool = require('../db');
async function main() {
  await pool.query('SELECT id,total,totals,payment_method,payment_status FROM sales LIMIT 0');
  await pool.query('SELECT request_key,user_id,sale_id,quote,amount_paise,gateway_order_id,gateway_payment_id,gateway_state,cart_cleared FROM mobile_checkouts LIMIT 0');
  await pool.query('SELECT sale_id,razorpay_order_id,razorpay_payment_id,amount_paise,status FROM payments LIMIT 0');
  const type = (await pool.query("SELECT data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='sales' AND column_name='totals'")).rows[0]?.data_type;
  if (type !== 'jsonb') throw new Error('sales.totals must use the existing JSONB schema.');
  for (const key of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET']) if (!process.env[key]) throw new Error(`${key} is required for COD advance payments.`);
  if (!(process.env.MOBILE_RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET)) throw new Error('Configure the Razorpay webhook secret and payment.captured event.');
  console.log('COD advance schema and payment environment are ready. No COD database migration is required.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
