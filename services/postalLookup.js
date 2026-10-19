const { canonicalState, validPin } = require('./indiaLocations');
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });
const unavailable = () => fail('PIN lookup is temporarily unavailable. Enter your city and full state name manually, or retry.', 503, 'PIN_LOOKUP_UNAVAILABLE');
const clean = value => String(value || '').trim().slice(0, 120);
const usable = value => value && !/^(na|n\/a|null|not available|nil)$/i.test(value);
async function getPostalData(url, { timeout, maxContentLength }) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'V1Garments/1.0' } });
  if (!response.ok || !response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxContentLength) { await reader.cancel(); throw unavailable(); }
    chunks.push(Buffer.from(value));
  }
  return { data: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}
function createPostalLookup({ get = getPostalData, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map();
  async function lookup(value) {
    const pin = String(value || '').trim();
    if (!validPin(pin)) throw fail('Enter a valid 6-digit Indian PIN code.', 400, 'INVALID_PIN');
    const cached = cache.get(pin);
    if (cached && cached.until > now()) {
      if (cached.error) throw cached.error;
      return cached.data;
    }
    if (pending.has(pin)) return pending.get(pin);
    if (pending.size >= 50) throw unavailable();
    const job = (async () => {
      try {
        const response = await get(`https://api.postalpincode.in/pincode/${pin}`, { timeout: 5000, maxContentLength: 1024 * 1024 });
        const entry = response.data?.[0];
        if (entry?.Status === 'Error' && /no records? found/i.test(String(entry.Message))) throw fail('PIN code not found. Check all six digits.', 404, 'PIN_NOT_FOUND');
        if (entry?.Status !== 'Success' || !Array.isArray(entry.PostOffice)) throw unavailable();
        const offices = entry.PostOffice.filter(row => String(row.Pincode) === pin && /^india$/i.test(clean(row.Country)) && canonicalState(row.State));
        if (!offices.length) throw unavailable();
        const states = [...new Set(offices.map(row => canonicalState(row.State)))];
        const districts = [...new Set(offices.map(row => clean(row.District)).filter(usable))];
        const cities = [...new Set(offices.map(row => clean(row.Block)).filter(usable))];
        const data = { pincode: pin, state: states.length === 1 ? states[0] : '', states, city: cities.length === 1 ? cities[0] : districts.length === 1 ? districts[0] : '', districts, cities: [...new Set([...cities, ...districts])].slice(0, 100), source: 'PostalPincode.in' };
        if (cache.size >= 1000) cache.delete(cache.keys().next().value);
        cache.set(pin, { data, until: now() + 86400000 });
        return data;
      } catch (error) {
        const safe = error.code === 'PIN_NOT_FOUND' ? error : unavailable();
        if (cache.size >= 1000) cache.delete(cache.keys().next().value);
        cache.set(pin, { error: safe, until: now() + (safe.status === 404 ? 300000 : 15000) });
        throw safe;
      }
    })();
    pending.set(pin, job);
    try { return await job; } finally { pending.delete(pin); }
  }
  async function validate(address) {
    let location;
    try { location = await lookup(address.pincode); }
    catch (error) { if (error.status === 503) return; throw error; }
    if (!location.states.includes(canonicalState(address.state))) throw fail('The selected state does not match this PIN code. Check the delivery address.', 400, 'PIN_STATE_MISMATCH');
  }
  return { lookup, validate };
}
module.exports = { createPostalLookup, ...createPostalLookup() };
