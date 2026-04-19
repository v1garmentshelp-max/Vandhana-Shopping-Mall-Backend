const axios = require('axios');
const crypto = require('crypto');

class RazorpayService {
  constructor({ keyId, keySecret }) {
    this.keyId = keyId || process.env.RAZORPAY_KEY_ID;
    this.keySecret = keySecret || process.env.RAZORPAY_KEY_SECRET;
    this.client = axios.create({
      baseURL: 'https://api.razorpay.com/v1',
      auth: { username: this.keyId, password: this.keySecret }
    });
  }

  async createOrder({ amountPaise, currency = 'INR', receipt, notes }) {
    const { data } = await this.client.post('/orders', {
      amount: Number(amountPaise),
      currency,
      receipt: receipt || String(Date.now()),
      payment_capture: 1,
      notes: notes || {}
    });
    return data;
  }

  verifyPaymentSignature({ orderId, paymentId, signature }) {
    const hmac = crypto.createHmac('sha256', this.keySecret);
    hmac.update(`${orderId}|${paymentId}`);
    const digest = hmac.digest('hex');
    return digest === signature;
  }

  verifyWebhookSignature({ bodyRaw, signature, secret }) {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(bodyRaw);
    const digest = hmac.digest('hex');
    return digest === signature;
  }
}

module.exports = RazorpayService;
