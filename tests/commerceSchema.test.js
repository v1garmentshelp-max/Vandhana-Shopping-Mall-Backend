const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
test('operations migration supports legacy enum and single-column status constraints without rewriting old orders',async()=>{
  const db=new PGlite();
  try {
    await db.exec(fs.readFileSync(path.join(__dirname,'support/mobile-schema.sql'),'utf8'));
    for(const file of ['20260923_order_shipping.sql','20260923_mobile.sql','20260925_mobile_store.sql','20260929_store_commerce.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../migrations',file),'utf8'));
    await db.exec(`CREATE TYPE legacy_order_state AS ENUM('PLACED','CANCELLED');
      CREATE TYPE legacy_payment_state AS ENUM('PENDING','PAID');
      ALTER TABLE sales ALTER COLUMN status TYPE legacy_order_state USING status::legacy_order_state;
      ALTER TABLE sales ALTER COLUMN payment_status TYPE legacy_payment_state USING payment_status::legacy_payment_state;
      ALTER TABLE sales ADD CONSTRAINT legacy_order_check CHECK(status IN ('PLACED','CANCELLED'));
      ALTER TABLE sales ADD CONSTRAINT legacy_payment_check CHECK(payment_status IN ('PENDING','PAID'));
      ALTER TABLE return_requests ADD CONSTRAINT legacy_return_check CHECK(status IN ('REQUESTED','APPROVED','REJECTED'));
      INSERT INTO sales(id,status,payment_status,total)VALUES('00000000-0000-4000-8000-000000000001','PLACED','PAID',540);`);
    const migration=fs.readFileSync(path.join(__dirname,'../migrations/20261003_order_operations.sql'),'utf8');
    await db.exec(migration);await db.exec(migration);
    assert.equal((await db.query('SELECT status,payment_status,total FROM sales')).rows[0].status,'PLACED');
    await db.exec(`UPDATE sales SET status='RTO',payment_status='PARTIALLY_REFUNDED';
      INSERT INTO return_requests(sale_id,status)VALUES('00000000-0000-4000-8000-000000000001','RECEIVED');`);
    assert.equal((await db.query('SELECT total FROM sales')).rows[0].total,'540');
    assert.equal((await db.query("SELECT CASE WHEN c.status='REQUESTED' THEN 'CANCELLATION REQUESTED' ELSE s.status::text END AS display_status FROM sales s LEFT JOIN storefront_cancellations c ON c.sale_id=s.id")).rows[0].display_status,'RTO');
    await assert.rejects(db.exec("UPDATE return_requests SET status='UNRECOGNISED'"),/check constraint/);
  }finally{await db.close();}
});
