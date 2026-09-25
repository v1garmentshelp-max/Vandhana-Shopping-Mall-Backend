const {
  fail,
  money,
  integer
} = require('./mobileRules');
const policy = {
  window_days: 7,
  innerwear_returns: false,
  text: 'Request a return within 7 days of delivery. Innerwear cannot be returned.'
};
const hex = value => /^#[a-f0-9]{6}$/i.test(String(value));
async function config(db) {
  const q = await db.query('SELECT config,updated_at FROM mobile_store_settings WHERE id=true');
  if (!q.rowCount) throw fail('Store settings are unavailable.', 503);
  return {
    ...q.rows[0].config,
    returns: policy,
    updated_at: q.rows[0].updated_at
  };
}
function validateConfig(input) {
  const c = input?.customizer;
  if (!c || typeof c.enabled !== 'boolean' || !Array.isArray(c.garments) || c.garments.length !== 3) throw fail('Configure the three supported garments.');
  const ids = new Set();
  const garments = c.garments.map(g => {
    if (!['crew', 'hoodie', 'longsleeve'].includes(g.id) || ids.has(g.id) || typeof g.enabled !== 'boolean') throw fail('Invalid garment configuration.');
    ids.add(g.id);
    const price = money(g.price),
      mrp = money(g.mrp);
    if (!(price > 0 && price <= 100000 && mrp >= price && mrp <= 100000)) throw fail('Enter valid selling and original prices.');
    return {
      id: g.id,
      name: String(g.name || '').trim().slice(0, 80) || g.id,
      price,
      mrp,
      enabled: g.enabled
    };
  });
  if (!Array.isArray(c.sizes) || !c.sizes.length || c.sizes.length > 15 || c.sizes.some(s => !/^[a-z0-9 -]{1,12}$/i.test(s))) throw fail('Enter valid sizes.');
  if (!Array.isArray(c.colors) || !c.colors.length || c.colors.length > 24 || c.colors.some(x => !hex(x.code) || !x.name)) throw fail('Enter valid garment colours.');
  const supportEmail = String(input?.support?.email || '').trim().toLowerCase();
  if (supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) throw fail('Enter a valid support email.');
  return {
    support: {
      email: supportEmail
    },
    customizer: {
      enabled: c.enabled,
      garments,
      sizes: [...new Set(c.sizes)],
      colors: c.colors.map(x => ({
        name: String(x.name).slice(0, 40),
        code: x.code.toLowerCase()
      }))
    }
  };
}
function customProduct(payload, settings) {
  const c = settings?.customizer;
  const garment = c?.garments?.find(g => g.id === payload?.garmentType && g.enabled);
  if (!c?.enabled || !garment) throw fail('This custom garment is currently unavailable.', 409);
  if (!c.sizes.includes(payload.size) || !c.colors.some(x => x.code.toLowerCase() === String(payload.color).toLowerCase())) throw fail('Choose an available size and colour.', 409);
  return {
    price: money(garment.price),
    mrp: money(garment.mrp),
    name: `Custom ${garment.name}`,
    size: payload.size,
    colour: payload.color
  };
}
async function validateDesign(db, userId, input) {
  const payload = {
    garmentType: input?.garmentType,
    size: input?.size,
    color: input?.color,
    version: 1,
    sides: {},
    design: {},
    designOnly: {}
  };
  customProduct(payload, await config(db));
  const assets = new Set();
  const sourceUrl = value => {
    if (typeof value !== 'string' || !/^https:\/\//.test(value) || value.length > 2000) throw fail('Upload the artwork before saving your design.');
    assets.add(value);
    return value;
  };
  for (const side of ['front', 'back']) {
    const layers = input?.sides?.[side] || [];
    if (!Array.isArray(layers) || layers.length > 12) throw fail('Use up to 12 layers per side.');
    payload.sides[side] = layers.map((l, i) => {
      if (!['text', 'image'].includes(l.type)) throw fail('Invalid design layer.');
      const n = (key, min, max, def) => {
        const value = Number(l[key] ?? def);
        if (!Number.isFinite(value) || value < min || value > max) throw fail('Keep your design inside the print area.');
        return value;
      };
      const layer = {
        id: String(l.id || i).slice(0, 60),
        type: l.type,
        x: n('x', 0, 1, .5),
        y: n('y', 0, 1, .5),
        width: n('width', .05, 1, .5),
        height: n('height', .05, 1, .25),
        rotation: n('rotation', -180, 180, 0)
      };
      if (l.type === 'image') layer.url = sourceUrl(l.url);else {
        layer.text = String(l.text || '').slice(0, 120);
        layer.color = hex(l.color) ? l.color : '#000000';
        layer.font = ['sans', 'serif', 'mono'].includes(l.font) ? l.font : 'sans';
        layer.bold = !!l.bold;
        if (!layer.text.trim()) throw fail('Enter text or remove the empty layer.');
      }
      return layer;
    });
    if (input?.design?.[side]) payload.design[side] = sourceUrl(input.design[side]);
    if (input?.designOnly?.[side]) payload.designOnly[side] = sourceUrl(input.designOnly[side]);
  }
  if (!payload.design.front || !payload.design.back || !payload.designOnly.front || !payload.designOnly.back) throw fail('Generate both design previews before saving.');
  const owned = await db.query('SELECT url FROM mobile_uploads WHERE user_id=$1 AND url=ANY($2::text[])', [userId, [...assets]]);
  if (new Set(owned.rows.map(x => x.url)).size !== assets.size) throw fail('One of these images does not belong to your account.', 403);
  return payload;
}
async function addDesignToCart(db, userId, id, quantity) {
  const q = await db.query('SELECT * FROM mobile_designs WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!q.rowCount) throw fail('Design not found.', 404);
  const payload = q.rows[0].payload,
    item = customProduct(payload, await config(db));
  const r = await db.query(`INSERT INTO vandana_cart(user_id,product_id,selected_size,selected_color,quantity,is_custom,custom_title,custom_brand,custom_image_url,custom_price,custom_original_price,custom_payload,created_at,updated_at)
    VALUES($1,NULL,$2,$3,$4,true,$5,'V1Garments',$6,$7,$8,$9::jsonb,now(),now()) RETURNING id`, [userId, item.size, item.colour, integer(quantity || 1, 1, 20), item.name, payload.design.front, item.price, item.mrp, JSON.stringify({
    ...payload,
    design_id: id
  })]);
  return {
    cart_item_id: r.rows[0].id
  };
}
module.exports = {
  config,
  validateConfig,
  customProduct,
  validateDesign,
  addDesignToCart,
  policy
};
