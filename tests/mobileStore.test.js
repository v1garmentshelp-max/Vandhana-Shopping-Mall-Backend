const {
  test,
  before,
  after
} = require('node:test');
const assert = require('node:assert/strict');
const {
  PGlite
} = require('@electric-sql/pglite');
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const store = require('../services/mobileStore'),
  returns = require('../services/returnPolicy');
let pg, db;
before(async () => {
  pg = new PGlite();
  db = {
    query: async (s, v) => {
      const r = await pg.query(s, v);
      return {
        ...r,
        rowCount: Math.max(r.rows.length, r.affectedRows || 0)
      };
    },
    connect: async () => ({
      ...db,
      release() {}
    })
  };
  await pg.exec(fs.readFileSync(path.join(__dirname, 'support/mobile-schema.sql'), 'utf8'));
  await pg.exec(fs.readFileSync(path.join(__dirname, '../migrations/20260925_mobile_store.sql'), 'utf8'));
});
after(async () => pg.close());
test('custom prices are controlled by the shared server configuration and disabled garments cannot checkout', async () => {
  const c = await store.config(db),
    p = {
      garmentType: 'crew',
      size: 'M',
      color: '#ffffff',
      price: 1
    };
  assert.equal(store.customProduct(p, c).price, 799);
  assert.throws(() => store.customProduct({
    ...p,
    size: 'fake'
  }, c), /available size/);
  assert.throws(() => store.customProduct(p, {
    customizer: {
      ...c.customizer,
      enabled: false
    }
  }), /unavailable/);
  assert.throws(() => store.validateConfig({
    customizer: {
      ...c.customizer,
      garments: c.customizer.garments.map(g => ({
        ...g,
        price: -1
      }))
    }
  }), /prices/);
});
test('design assets must belong to the signed-in customer', async () => {
  const p = {
    garmentType: 'crew',
    size: 'M',
    color: '#ffffff',
    sides: {
      front: [],
      back: []
    },
    design: {
      front: 'https://example.test/a.png',
      back: 'https://example.test/a.png'
    },
    designOnly: {
      front: 'https://example.test/a.png',
      back: 'https://example.test/a.png'
    }
  };
  await db.query('INSERT INTO mobile_uploads(id,user_id,url) VALUES($1,1,$2)', [crypto.randomUUID(), p.design.front]);
  assert.equal((await store.validateDesign(db, 1, p)).garmentType, 'crew');
  await assert.rejects(store.validateDesign(db, 2, p), /belong/);
});
test('mixed order returns exclude descendant innerwear categories, use actual delivery date, and reject duplicate quantities', async () => {
  const id = crypto.randomUUID(),
    normal = crypto.randomUUID(),
    inner = crypto.randomUUID();
  await pg.exec("INSERT INTO product_categories VALUES(1,'Inner Wear',NULL),(2,'Vests',1),(3,'Shirts',NULL);UPDATE products SET category_id=3 WHERE id=1;INSERT INTO products(id,name,is_active,category_id) VALUES(2,'Cotton vest',true,2)");
  await db.query("INSERT INTO sales(id,customer_email,customer_mobile,status,created_at) VALUES($1,'customer@example.test','9999999999','DELIVERED',now()-interval '30 days')", [id]);
  for (const [item, product, variant] of [[normal, 1, 11], [inner, 2, 22]]) await db.query('INSERT INTO sale_items(id,sale_id,product_id,variant_id,qty) VALUES($1,$2,$3,$4,2)', [item, id, product, variant]);
  await db.query("INSERT INTO shipments(id,sale_id,status,created_at,delivered_at) VALUES($1,$2,'DELIVERED',now()-interval '20 days',now()-interval '1 day')", [crypto.randomUUID(), id]);
  let e = await returns.eligibility(db, id);
  assert.equal(e.ok, true);
  assert.equal(e.items.find(i => i.sale_item_id === inner).eligible, false);
  await assert.rejects(returns.createReturn(db, id, {
    reason: 'Wrong size received',
    items: [{
      sale_item_id: inner,
      qty: 1
    }]
  }), /Innerwear/);
  await returns.createReturn(db, id, {
    reason: 'Wrong size received',
    items: [{
      sale_item_id: normal,
      qty: 1
    }]
  });
  e = await returns.eligibility(db, id);
  assert.equal(e.items.find(i => i.sale_item_id === normal).remaining_qty, 1);
  await assert.rejects(returns.createReturn(db, id, {
    reason: 'Wrong size received',
    items: [{
      sale_item_id: normal,
      qty: 2
    }]
  }), /Invalid quantity/);
  await db.query("UPDATE shipments SET delivered_at=now()-interval '8 days' WHERE sale_id=$1", [id]);
  e = await returns.eligibility(db, id);
  assert.equal(e.ok, false);
  await db.query('UPDATE shipments SET delivered_at=NULL WHERE sale_id=$1', [id]);
  e = await returns.eligibility(db, id);
  assert.equal(e.ok, false);
  assert.match(e.reason, /awaiting confirmation/);
});
