require('dotenv').config();
const pool = require('../db');
const {
  getSettings,
  creditSignupBonus
} = require('../services/rewardPointsService');
async function main() {
  const userId = Number(process.argv[2]);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Usage: node scripts/repairSignupBonus.js USER_ID [--apply]');
  const settings = await getSettings(pool);
  const user = await pool.query('SELECT id, type, created_at FROM vandana_users WHERE id = $1', [userId]);
  if (!user.rowCount) throw new Error('Customer not found');
  const existing = await pool.query("SELECT id, points_granted, points_remaining, status, expires_at FROM reward_point_lots WHERE user_id=$1 AND source_type='SIGNUP_BONUS'", [userId]);
  console.log(JSON.stringify({
    user: user.rows[0],
    settings,
    existing_signup_bonus: existing.rows
  }, null, 2));
  if (!process.argv.includes('--apply')) {
    console.log('Read-only preview. Add --apply to credit this customer using the current reward settings.');
    return;
  }
  const result = await creditSignupBonus(userId);
  console.log(result ? JSON.stringify({
    signup_bonus: result
  }, null, 2) : 'No credit: rewards are disabled, bonus is zero, or the account is not B2C.');
}
main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
