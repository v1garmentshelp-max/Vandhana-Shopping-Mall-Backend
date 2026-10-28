const axios = require('axios');
const crypto = require('crypto');
function paymentError(message, status, code, orderCreationRejected = false) {
  return Object.assign(new Error(message), { status, code, orderCreationRejected });
}
function matchesSignature(body, signature, secret) {
  if (!secret || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
class RazorpayService {
  constructor({
    keyId,
    keySecret
  }) {
    this.keyId = keyId || process.env.RAZORPAY_KEY_ID;
    this.keySecret = keySecret || process.env.RAZORPAY_KEY_SECRET;
    this.client = axios.create({
      baseURL: 'https://api.razorpay.com/v1',
      timeout: 15000,
      auth: {
        username: this.keyId,
        password: this.keySecret
      }
    });
    this.client.interceptors.response.use(response => response, error => {
      const status = Number(error.response?.status);
      const rejected = [400, 401, 403, 404, 422, 429].includes(status);
      if (status === 401 || status === 403) throw paymentError('The store payment credentials were rejected. Please contact the store.', 401, 'RAZORPAY_AUTH_FAILED', true);
      throw paymentError('The payment provider is temporarily unavailable. Please try again or check your saved order.', 500, 'RAZORPAY_API_ERROR', rejected);
    });
  }
  async createOrder({
    amountPaise,
    currency = 'INR',
    receipt,
    notes
  }) {
    const amount = Number(amountPaise);
    if (!Number.isSafeInteger(amount) || amount < 100) throw paymentError('Payment amount must be at least 100 paise and use whole paise.', 400, 'INVALID_PAYMENT_AMOUNT', true);
    if (!/^[A-Z]{3}$/.test(currency)) throw paymentError('Enter a valid payment currency.', 400, 'INVALID_PAYMENT_CURRENCY', true);
    if (!this.keyId || !this.keySecret) throw paymentError('Secure payment is temporarily unavailable. Please contact the store.', 503, 'ONLINE_UNAVAILABLE', true);
    const {
      data
    } = await this.client.post('/orders', {
      amount,
      currency,
      receipt: receipt || String(Date.now()),
      notes: notes || {}
    });
    if (!data?.id || Number(data.amount) !== amount || data.currency !== currency) throw paymentError('The payment order needs reconciliation. Please check your saved order.', 500, 'PAYMENT_RECONCILIATION');
    return data;
  }
  verifyPaymentSignature({
    orderId,
    paymentId,
    signature
  }) {
    if (typeof orderId !== 'string' || !orderId || typeof paymentId !== 'string' || !paymentId) return false;
    return matchesSignature(`${orderId}|${paymentId}`, signature, this.keySecret);
  }
  verifyWebhookSignature({
    bodyRaw,
    signature,
    secret
  }) {
    if (!Buffer.isBuffer(bodyRaw) && typeof bodyRaw !== 'string') return false;
    return matchesSignature(bodyRaw, signature, secret);
  }
}
module.exports = RazorpayService;
