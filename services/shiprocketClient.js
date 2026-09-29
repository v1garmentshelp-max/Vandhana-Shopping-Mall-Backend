// services/shiprocketClient.js
const axios = require('axios');

const BASE = process.env.SHIPROCKET_API_BASE || 'https://apiv2.shiprocket.in';

let token = null;
let fetchedAt = 0;
const TTL = 25 * 60 * 1000; // refresh every ~25 mins (conservative)

async function login() {
  const email = process.env.SHIPROCKET_API_USER_EMAIL;
  const password = process.env.SHIPROCKET_API_USER_PASSWORD;
  if (!email || !password) throw new Error('Missing Shiprocket API creds');

  const { data } = await axios.post(`${BASE}/v1/external/auth/login`, { email, password });
  token = data.token;
  fetchedAt = Date.now();
  return token;
}

async function withAuth(cfg) {
  if (!token || Date.now() - fetchedAt > TTL) await login();
  const headers = { ...(cfg.headers || {}), Authorization: `Bearer ${token}` };
  const { data } = await axios({ baseURL: BASE, ...cfg, headers });
  return data;
}

// ========== Public helpers we’ll use in controllers ==========
exports.listOrders = async (page = 1) =>
  withAuth({ method: 'get', url: '/v1/external/orders', params: { per_page: 50, page } });

exports.trackByOrderId = (orderId, channelId) =>
  withAuth({
    method: 'get',
    url: '/v1/external/courier/track',
    params: { order_id: orderId, ...(channelId ? { channel_id: channelId } : {}) }
  });
