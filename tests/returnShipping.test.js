const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
let db,calls=[],remoteAwb=null,pickupDate=null,mode='',remoteReference='RET-7';
class Carrier {
  async init(){}
  async api(method,path,body){
    calls.push({method,path,body});
    if(path.startsWith('/orders/show/'))return {data:{data:{id:91,channel_order_id:remoteReference,status:remoteAwb?'AWB ASSIGNED':'NEW',shipments:[{id:92,awb:remoteAwb,pickup_scheduled_date:pickupDate}]}}};
    if(path==='/orders/create/return')return {data:{order_id:91,shipment_id:92}};
    if(path==='/courier/serviceability/')return {data:{data:{available_courier_companies:[{courier_company_id:61,courier_name:'Reverse fixture'}]}}};
    if(path==='/courier/assign/awb'){remoteAwb='RETURNTEST';if(mode==='awb-timeout')throw new Error('timeout after assignment');return {data:{awb_assign_status:1,response:{data:{awb_code:remoteAwb}}}};}
    if(path==='/courier/generate/pickup'){if(mode==='pickup-timeout')throw new Error('timeout after pickup request');pickupDate='2026-10-03 15:00:00';return {data:{pickup_status:1}};}
    throw new Error('Unexpected carrier request');
  }
}
require.cache[require.resolve('../services/shiprocketService')]={exports:Carrier};
const ReturnsService=require('../services/returnsService');
const request={id:7,created_at:'2026-10-03T08:00:00Z'};
const sale={id:'00000000-0000-4000-8000-000000000001',branch_id:3,customer_name:'Buyer',customer_email:'buyer@example.test',customer_mobile:'9999999999',shipping_address:{line1:'12 Buyer Road',city:'Tirupati',state:'Andhra Pradesh',pincode:'517501'}};
const context={request,sale,branch:{id:3,name:'Original branch'},items:[{sale_item_id:1,variant_id:11,qty:1}]};
let svc;
before(async()=>{
  db=new PGlite();
  await db.exec(`CREATE TABLE sale_items(id bigint,sale_id uuid,variant_id bigint,product_id bigint,qty int,price numeric,custom_title text);
    CREATE TABLE shiprocket_warehouses(branch_id bigint,name text,address text,city text,state text,pincode text,phone text);
    CREATE TABLE reverse_shipments(id bigserial,request_id bigint,shiprocket_order_id text,shiprocket_shipment_id text,awb text,status text,
      status_synced_at timestamptz,last_tracking_payload jsonb,last_error text,awb_attempted bool DEFAULT false,pickup_attempted bool DEFAULT false,pickup_requested_at timestamptz);`);
  svc=new ReturnsService({pool:{query:async(sql,args)=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows||r.rows.length};}}});
});
beforeEach(async()=>{
  calls=[];remoteAwb=null;pickupDate=null;mode='';remoteReference='RET-7';
  await db.exec(`TRUNCATE sale_items,shiprocket_warehouses,reverse_shipments RESTART IDENTITY;
    INSERT INTO sale_items VALUES(1,'${sale.id}',11,1,2,500,NULL);
    INSERT INTO shiprocket_warehouses VALUES(3,'Original branch','5 Warehouse Road','Tirupati','Andhra Pradesh','517502','8888888888');`);
});
after(async()=>db.close());
test('return booking uses customer pickup, original warehouse destination and actual invoice prices, then saves before AWB',async()=>{
  const reverse=await svc.createReversePickup({...context,parcel:{weight:1.1,length:22,breadth:18,height:8}});
  assert.equal(reverse.shiprocket_order_id,'91');assert.equal(reverse.shiprocket_shipment_id,'92');
  assert.equal(calls.length,1);const payload=calls[0].body;
  assert.equal(calls[0].path,'/orders/create/return');
  assert.equal(payload.pickup_address,sale.shipping_address.line1);assert.equal(payload.shipping_address,'5 Warehouse Road');
  assert.equal(payload.order_items[0].selling_price,500);assert.equal(payload.sub_total,500);assert.equal(payload.weight,1.1);
  assert.equal(payload.is_return,undefined);assert.equal((await db.query('SELECT count(*)::int n FROM reverse_shipments')).rows[0].n,1);
});
test('invalid pickup configuration and ambiguous old invoice items fail before contacting Shiprocket',async()=>{
  await db.exec("UPDATE shiprocket_warehouses SET phone=NULL");
  await assert.rejects(svc.returnPayload(context),/phone numbers/);assert.equal(calls.length,0);
  await db.exec("UPDATE shiprocket_warehouses SET phone='8888888888';INSERT INTO sale_items VALUES(2,'00000000-0000-4000-8000-000000000001',11,1,1,500,NULL)");
  await assert.rejects(svc.returnPayload({...context,items:[{variant_id:11,qty:1}]}),/one original invoice/);assert.equal(calls.length,0);
});
test('uncertain reverse AWB is reconciled to the same booking without assigning another AWB',async()=>{
  await svc.createReversePickup(context);mode='awb-timeout';
  await assert.rejects(svc.assignAwb(request,61,sale),/timeout/);mode='';
  const result=await svc.assignAwb(request,61,sale);
  assert.equal(result.reverse.awb,'RETURNTEST');assert.equal(calls.filter(c=>c.path==='/courier/assign/awb').length,1);
  assert.equal(calls.find(c=>c.path==='/courier/assign/awb').body.is_return,1);
});
test('a pickup timeout cannot send a second request and a later saved carrier schedule resolves it',async()=>{
  await svc.createReversePickup(context);await svc.assignAwb(request,61,sale);mode='pickup-timeout';
  await assert.rejects(svc.pickup(request),/timeout/);mode='';await assert.rejects(svc.pickup(request),/may already be scheduled/);
  pickupDate='2026-10-03 15:00:00';const result=await svc.pickup(request);
  assert.ok(result.reverse.pickup_requested_at);assert.equal(calls.filter(c=>c.path==='/courier/generate/pickup').length,1);
});
test('return reconciliation rejects another request reference and unavailable reverse couriers',async()=>{
  await svc.createReversePickup(context);remoteReference='RET-8';
  await assert.rejects(svc.reconcile(request),/does not match/);remoteReference='RET-7';
  await assert.rejects(svc.assignAwb(request,999,sale),/unavailable/);assert.equal(calls.filter(c=>c.path==='/courier/assign/awb').length,0);
});
