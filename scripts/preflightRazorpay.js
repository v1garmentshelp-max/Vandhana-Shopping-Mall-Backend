require('dotenv').config();
const Razorpay = require('../services/razorpayService');

async function main() {
  const keyId = process.env.RAZORPAY_KEY_ID || '';
  const secret = process.env.RAZORPAY_KEY_SECRET || '';
  const webhookSecret = process.env.MOBILE_RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET || '';
  const errors = [];
  if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId)) errors.push('Set a valid backend RAZORPAY_KEY_ID.');
  if (!secret) errors.push('Set backend RAZORPAY_KEY_SECRET.');
  if (!webhookSecret) errors.push('Set MOBILE_RAZORPAY_WEBHOOK_SECRET to the exact secret saved in the Razorpay webhook.');
  if (secret && webhookSecret === secret) errors.push('Use a separate webhook secret instead of the API key secret.');
  if (keyId && secret && process.argv.includes('--check-api')) {
    try {
      await new Razorpay({}).client.get('/orders', { params: { count: 1 } });
      console.log('Razorpay API authentication succeeded. No order or payment was created.');
    } catch (error) {
      errors.push(error.message);
    }
  }
  console.log(`Payment mode: ${keyId.startsWith('rzp_test_') ? 'TEST: simulated payments only' : keyId.startsWith('rzp_live_') ? 'LIVE' : 'not configured'}`);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Razorpay environment is ready. Verify capture settings and webhook deliveries in the same dashboard mode.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
