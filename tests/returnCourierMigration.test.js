const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
test('return courier migration adds all nine missing public columns twice without changing bookings',async()=>{
  const db=new PGlite();
  try{
    await db.exec("CREATE TABLE public.reverse_shipments(id bigint PRIMARY KEY,request_id bigint,status text,awb text); INSERT INTO public.reverse_shipments VALUES(1,11,'AWB_ASSIGNED','EXISTING-AWB'); CREATE SCHEMA shadow; CREATE TABLE shadow.reverse_shipments(id bigint); SET search_path=shadow,public;");
    const migration=fs.readFileSync(path.join(__dirname,'../migrations/20261030_return_couriers.sql'),'utf8');
    await db.exec(migration);await db.exec(migration);
    const expected=['booking_reference','courier_id','courier_name','parcel','operation','awb_history','cancelled_at','reassigned_at','cancellation_reason'];
    const columns=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='reverse_shipments'")).rows.map(row=>row.column_name);
    for(const column of expected)assert(columns.includes(column),column);
    const row=(await db.query('SELECT * FROM public.reverse_shipments')).rows[0];
    assert.equal(row.id,1);assert.equal(row.request_id,11);assert.equal(row.status,'AWB_ASSIGNED');assert.equal(row.awb,'EXISTING-AWB');assert.deepEqual(row.awb_history,[]);assert.equal(row.operation,null);
    const shadow=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='shadow' AND table_name='reverse_shipments'")).rows;
    assert.deepEqual(shadow.map(row=>row.column_name),['id']);
  }finally{await db.close();}
});
