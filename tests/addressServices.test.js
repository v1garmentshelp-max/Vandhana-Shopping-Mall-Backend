const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPostalLookup } = require('../services/postalLookup');
const { createDeliveryEstimator } = require('../services/deliveryEstimate');
const { states, canonicalState } = require('../services/indiaLocations');
const { addressOf } = require('../services/mobileRules');
const office = (fields = {}) => ({ Name: 'Srikakulam', Block: 'Srikakulam', District: 'Srikakulam', State: 'Andhra Pradesh', Country: 'India', Pincode: '532001', ...fields });
const response = offices => ({ data: [{ Status: 'Success', PostOffice: offices }] });

test('all states and Union territories are canonical; partial names cannot be saved', () => {
  assert.equal(states.length, 36);
  assert.equal(new Set(states).size, 36);
  assert.equal(canonicalState('An'), '');
  assert.equal(canonicalState('AP'), 'Andhra Pradesh');
  assert.equal(canonicalState('Orissa'), 'Odisha');
  assert.equal(canonicalState('Andaman & Nicobar Islands'), 'Andaman and Nicobar Islands');
  assert.throws(() => addressOf({ fullName: 'Test Buyer', mobile: '9999999999', line1: '12 Main Road', city: 'Srikakulam', pincode: '532001', state: 'An' }));
});
test('PIN lookup fills the screenshot location, coalesces requests, caches results and checks mismatches', async () => {
  let calls = 0;
  const api = createPostalLookup({ get: async (url, config) => { calls++; assert.ok(url.endsWith('/532001')); assert.equal(config.timeout, 5000); return response([office(), office({ Name: 'Collectorate' })]); } });
  const [a, b] = await Promise.all([api.lookup('532001'), api.lookup('532001')]);
  assert.equal(a.state, 'Andhra Pradesh'); assert.equal(a.city, 'Srikakulam'); assert.deepEqual(a, b);
  await api.lookup('532001'); assert.equal(calls, 1);
  await api.validate({ pincode: '532001', state: 'Andhra Pradesh' });
  await assert.rejects(api.validate({ pincode: '532001', state: 'Telangana' }), { code: 'PIN_STATE_MISMATCH' });
  await assert.rejects(api.lookup('../../secret'), { status: 400 }); assert.equal(calls, 1);
});
test('city selection handles Delhi blocks, absent blocks and ambiguous states', async () => {
  const delhi = createPostalLookup({ get: async () => response([office({ Pincode: '110001', Block: 'New Delhi', District: 'Central Delhi', State: 'Delhi' })]) });
  assert.equal((await delhi.lookup('110001')).city, 'New Delhi');
  const fallback = createPostalLookup({ get: async () => response([office({ Block: 'NA' })]) });
  assert.equal((await fallback.lookup('532001')).city, 'Srikakulam');
  const ambiguous = createPostalLookup({ get: async () => response([office(), office({ State: 'Telangana' })]) });
  assert.equal((await ambiguous.lookup('532001')).state, '');
});
test('invalid, missing, malformed, wrong-PIN and unavailable results remain distinguishable', async () => {
  let count = 0, time = 0;
  const missing = createPostalLookup({ now: () => time, get: async () => { count++; return { data: [{ Status: 'Error', Message: 'No records found', PostOffice: null }] }; } });
  await assert.rejects(missing.lookup('999999'), { code: 'PIN_NOT_FOUND' });
  await assert.rejects(missing.lookup('999999'), { code: 'PIN_NOT_FOUND' }); assert.equal(count, 1);
  time = 300001; await assert.rejects(missing.lookup('999999'), { code: 'PIN_NOT_FOUND' }); assert.equal(count, 2);
  for (const get of [async () => { throw new Error('API secret diagnostic'); }, async () => ({ data: [] }), async () => response([office({ Pincode: '110001' })])]) {
    const api = createPostalLookup({ get });
    await assert.rejects(api.lookup('532001'), error => error.status === 503 && !error.message.includes('secret'));
    await api.validate({ pincode: '532001', state: 'Andhra Pradesh' });
  }
});
const env = { SHIPROCKET_API_USER_EMAIL: 'api@example.test', SHIPROCKET_API_USER_PASSWORD: 'test-only', STORE_ITEM_WEIGHT_KG: '0.5', STORE_PACKAGING_WEIGHT_KG: '0.1' };
const db = { query: async (_sql, params) => { assert.equal(params[0], 3); return { rows: [{ name: 'Main pickup', pincode: '517501' }] }; } };
const input = { db, branchId: 3, pincode: '532001', paymentMethod: 'COD', items: [{ qty: 2 }, { qty: 1 }] };
test('delivery uses mapped origin, server quantities, COD flag and live carrier durations', async () => {
  let calls = 0, last, time = 0;
  const api = createDeliveryEstimator({ env, now: () => time, client: { checkServiceability: async options => { calls++; last = options; return { status: 200, data: { available_courier_companies: [
    { courier_company_id: 1, cod: 1, blocked: '0', estimated_delivery_days: '4', pickup_availability: '0' },
    { courier_company_id: 2, cod: '1', blocked: 0, etd_hours: 120 },
    { courier_company_id: 3, cod: 1, blocked: '1', estimated_delivery_days: '1' },
    { courier_company_id: 4, cod: 0, blocked: 0, estimated_delivery_days: '2' }
  ] } }; } } });
  const result = await api.estimate(input);
  assert.deepEqual(last, { pickup_postcode: '517501', delivery_postcode: '532001', cod: true, weight: 1.6 });
  assert.equal(result.serviceable, true); assert.equal(result.min_days, 4); assert.equal(result.max_days, 5);
  await api.estimate(input); assert.equal(calls, 1);
  const prepaid = await api.estimate({ ...input, paymentMethod: 'ONLINE' }); assert.equal(prepaid.min_days, 2); assert.equal(calls, 2);
  time = 300001; await api.estimate(input); assert.equal(calls, 3);
});
test('empty couriers block delivery; missing durations never invent an arrival date', async () => {
  const empty = createDeliveryEstimator({ env, client: { checkServiceability: async () => ({ data: { available_courier_companies: [] } }) } });
  assert.equal((await empty.estimate(input)).serviceable, false);
  const noTime = createDeliveryEstimator({ env, client: { checkServiceability: async () => ({ data: { available_courier_companies: [{ courier_company_id: 1, cod: 1, estimated_delivery_days: 'unknown' }] } }) } });
  const result = await noTime.estimate(input); assert.equal(result.serviceable, true); assert.equal(result.min_days, null);
  assert.match(result.message, /not provided/);
});
test('missing credentials, mapping, errors and malformed responses produce unknown availability safely', async () => {
  const unavailable = async config => assert.equal((await createDeliveryEstimator(config).estimate(input)).serviceable, null);
  await unavailable({ env: {}, client: { checkServiceability: async () => { throw new Error('must not call'); } } });
  for (const response of [{}, { status: 401, data: { available_courier_companies: [] } }]) await unavailable({ env, client: { checkServiceability: async () => response } });
  await unavailable({ env, client: { checkServiceability: async () => { throw new Error('upstream credentials diagnostic'); } } });
  const api = createDeliveryEstimator({ env });
  assert.equal((await api.estimate({ ...input, db: { query: async () => ({ rows: [] }) } })).serviceable, null);
  await assert.rejects(api.estimate({ ...input, pincode: '123' }), { status: 400 });
  await assert.rejects(api.estimate({ ...input, paymentMethod: 'FREE' }), { status: 400 });
});
