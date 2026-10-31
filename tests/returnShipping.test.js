const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
let db,calls=[],remoteAwb=null,pickupDate=null,mode='',remoteReference='RET-7',remoteStatus='NEW',remoteCourier=null,created=0,remoteId=91,shipmentId=92;
const archived=new Map();
const snapshot=()=>({id:remoteId,channel_order_id:remoteReference,status:remoteStatus,shipments:[{id:shipmentId,status:remoteStatus,awb:remoteAwb,courier_id:remoteCourier,courier_name:remoteCourier===62?'Alternate carrier':'Reverse fixture',pickup_scheduled_date:pickupDate}]});
class Carrier {
  async init(){}
  async api(method,path,body){
    calls.push({method,path,body});
    if(path.startsWith('/orders/show/'))return {data:{data:Number(path.split('/').pop())===remoteId?snapshot():archived.get(Number(path.split('/').pop()))}};
    if(path==='/orders/create/return'){
      if(mode==='create-rejected')throw Object.assign(new Error('invalid parcel'),{status:422});
      if(created)archived.set(remoteId,snapshot());
      created++;remoteId=91+(created-1)*10;shipmentId=remoteId+1;remoteReference=body.order_id;remoteStatus='NEW';remoteAwb=null;remoteCourier=null;pickupDate=null;
      if(mode==='create-timeout')throw new Error('timeout after booking');
      return {data:{order_id:remoteId,shipment_id:shipmentId}};
    }
    if(path==='/courier/serviceability/')return {data:{data:{available_courier_companies:[{courier_company_id:61,courier_name:'Reverse fixture'},{courier_company_id:62,courier_name:'Alternate carrier'},{courier_company_id:63,courier_name:'Blocked carrier',blocked:'1'}]}}};
    if(path==='/courier/assign/awb'){
      if(mode==='awb-rejected')return {data:{awb_assign_status:0}};
      if(mode==='awb-auth')throw Object.assign(new Error('expired credentials'),{status:401});
      remoteAwb=body.status==='reassign'?'RETURNTEST2':'RETURNTEST';remoteCourier=body.courier_id;remoteStatus='AWB ASSIGNED';pickupDate=null;
      if(mode==='awb-timeout')throw new Error('timeout after assignment');
      return {data:{awb_assign_status:1,response:{data:{awb_code:remoteAwb,courier_company_id:remoteCourier}}}};
    }
    if(path==='/courier/generate/pickup'){
      if(mode==='pickup-rejected')return {data:{pickup_status:0}};
      if(mode==='pickup-timeout')throw new Error('timeout after pickup request');
      pickupDate='2026-10-03 15:00:00';remoteStatus='PICKUP SCHEDULED';return {data:{pickup_status:1}};
    }
    if(path==='/orders/cancel'){
      if(mode==='cancel-rejected')throw Object.assign(new Error('request rejected'),{status:422});
      remoteStatus=mode==='cancel-pending'?'RETURN CANCELLATION REQUESTED':'RETURN CANCELED';
      if(mode==='cancel-timeout')throw new Error('timeout after cancellation');
      return {data:{status_code:200}};
    }
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
      status_synced_at timestamptz,last_tracking_payload jsonb,last_error text,awb_attempted bool DEFAULT false,pickup_attempted bool DEFAULT false,pickup_requested_at timestamptz,carrier_event_at timestamptz);`);
  await db.exec(require('fs').readFileSync(require('path').join(__dirname,'../migrations/20261030_return_couriers.sql'),'utf8'));
  svc=new ReturnsService({pool:{query:async(sql,args)=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows||r.rows.length};}}});
});
beforeEach(async()=>{
  calls=[];remoteAwb=null;pickupDate=null;mode='';remoteReference='RET-7';remoteStatus='NEW';remoteCourier=null;created=0;remoteId=91;shipmentId=92;archived.clear();
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
test('serviceability excludes blocked couriers and passes a prepaid reverse route',async()=>{
  await svc.createReversePickup(context);
  const result=await svc.couriers(request,sale);
  assert.deepEqual(result.couriers.map(c=>c.courier_company_id),[61,62]);
  const call=calls.find(c=>c.path==='/courier/serviceability/');
  assert.equal(call.body.is_return,1);assert.equal(call.body.cod,0);assert.equal(call.body.pickup_postcode,'517501');
  await assert.rejects(svc.assignAwb(request,63,sale),/unavailable/);
});
test('courier reassignment preserves old AWB, clears old pickup and enforces 24 hour limit',async()=>{
  await svc.createReversePickup(context);await svc.assignAwb(request,61,sale);await svc.pickup(request);
  const changed=await svc.assignAwb(request,62,sale,{reassign:true,reason:'First courier did not arrive'});
  assert.equal(changed.reverse.awb,'RETURNTEST2');assert.equal(changed.reverse.courier_id,'62');
  assert.equal(changed.reverse.pickup_requested_at,null);assert.equal(changed.reverse.pickup_attempted,false);
  assert.equal(changed.reverse.awb_history[0].awb,'RETURNTEST');assert.ok(changed.reverse.reassigned_at);
  assert.equal(calls.filter(c=>c.path==='/orders/create/return').length,1);
  assert.equal(calls.filter(c=>c.path==='/courier/assign/awb')[1].body.status,'reassign');
  await assert.rejects(svc.assignAwb(request,61,sale,{reassign:true,reason:'Another courier change'}),/24 hours/);
  await svc.pickup(request);assert.equal(calls.filter(c=>c.path==='/courier/generate/pickup').length,2);
});
test('reassignment timeout is reconciled without another charge or assignment',async()=>{
  await svc.createReversePickup(context);await svc.assignAwb(request,61,sale);mode='awb-timeout';
  await assert.rejects(svc.assignAwb(request,62,sale,{reassign:true,reason:'Courier did not collect'}),/timeout/);
  assert.equal((await svc.latest(request)).operation.type,'REASSIGN');mode='';
  const refreshed=await svc.reconcile(request);assert.equal(refreshed.awb,'RETURNTEST2');assert.equal(refreshed.operation,null);
  await assert.rejects(svc.assignAwb(request,61,sale,{reassign:true,reason:'Another provider'}),/24 hours/);
  assert.equal(calls.filter(c=>c.path==='/courier/assign/awb').length,2);
});
test('pickup started and in transit block cancellation, new AWB and reassignment',async()=>{
  await svc.createReversePickup(context);await svc.assignAwb(request,61,sale);
  for(const status of ['RETURN OUT FOR PICKUP','RETURN PICKED UP','RETURN IN TRANSIT','RETURN DELIVERED']){
    remoteStatus=status;
    await assert.rejects(svc.cancel(request,'Courier did not arrive'),/does not allow/);
    await assert.rejects(svc.assignAwb(request,62,sale,{reassign:true,reason:'Courier did not arrive'}),/does not allow/);
    await assert.rejects(svc.pickup(request),/does not allow/);
  }
  assert.equal(calls.filter(c=>c.path==='/orders/cancel').length,0);
});
test('confirmed cancellation permits exactly one replacement booking with a new reference',async()=>{
  await svc.createReversePickup(context);await svc.assignAwb(request,61,sale);await svc.pickup(request);
  const cancelled=await svc.cancel(request,'Courier missed the agreed pickup');assert.equal(cancelled.confirmed,true);
  const result=await svc.rebook(context);assert.equal(result.reverse.booking_reference,'RET-7-R1');assert.equal(result.reverse.shiprocket_order_id,'101');
  assert.equal((await db.query('SELECT count(*)::int n FROM reverse_shipments')).rows[0].n,2);
  assert.ok((await db.query('SELECT cancelled_at FROM reverse_shipments WHERE id=1')).rows[0].cancelled_at);
  await assert.rejects(svc.rebook(context),/Wait for confirmed/);
  await svc.assignAwb(request,62,sale);assert.equal((await svc.latest(request)).courier_id,'62');
});
test('pending cancellation pauses replacement and repeated clicks do not recancel',async()=>{
  await svc.createReversePickup(context);await svc.assignAwb(request,61,sale);mode='cancel-pending';
  assert.equal((await svc.cancel(request,'Pickup not completed')).confirmed,false);
  assert.equal((await svc.cancel(request,'Pickup not completed')).confirmed,false);
  await assert.rejects(svc.rebook(context),/Wait for confirmed/);
  await assert.rejects(svc.assignAwb(request,62,sale,{reassign:true,reason:'Try another courier'}),/does not allow|awaiting/);
  assert.equal(calls.filter(c=>c.path==='/orders/cancel').length,1);
  remoteStatus='RETURN CANCELED';assert.equal((await svc.cancel(request,'Pickup not completed')).confirmed,true);
  await svc.rebook(context);assert.equal(created,2);
});
test('cancellation timeout uses remote confirmation before replacing the return',async()=>{
  await svc.createReversePickup(context);mode='cancel-timeout';
  await assert.rejects(svc.cancel(request,'Pickup not completed'),/timeout/);mode='';
  await svc.rebook(context);assert.equal(created,2);assert.equal(calls.filter(c=>c.path==='/orders/cancel').length,1);
});
test('uncertain replacement booking is saved and linked instead of being duplicated',async()=>{
  await svc.createReversePickup(context);await svc.cancel(request,'Pickup did not happen');mode='create-timeout';
  await assert.rejects(svc.rebook(context),/timeout/);
  const pending=await svc.latest(request);assert.equal(pending.booking_reference,'RET-7-R1');assert.equal(pending.status,'BOOKING_REVIEW');
  await assert.rejects(svc.rebook(context),/numeric Shiprocket/);assert.equal(created,2);
  mode='';const linked=await svc.reconcile(request,101);assert.equal(linked.id,pending.id);assert.equal(linked.shiprocket_order_id,'101');
  await assert.rejects(svc.reconcile(request,91),/different return/);
});
test('explicit booking and AWB rejections can retry while timeouts remain protected',async()=>{
  mode='create-rejected';await assert.rejects(svc.createReversePickup(context),/invalid parcel/);
  assert.equal((await svc.latest(request)).status,'BOOKING_FAILED');mode='';
  const booked=await svc.createReversePickup(context);assert.equal(booked.id,1);assert.equal(created,1);
  for(const failure of ['awb-rejected','awb-auth']){
    mode=failure;await assert.rejects(svc.assignAwb(request,61,sale));assert.equal((await svc.latest(request)).awb_attempted,false);
  }
  mode='';await svc.assignAwb(request,61,sale);mode='pickup-rejected';await assert.rejects(svc.pickup(request),/rejected/);
  assert.equal((await svc.latest(request)).pickup_attempted,false);mode='';await svc.pickup(request);
});
test('invalid courier changes and unsupported remote status cause no carrier mutation',async()=>{
  await svc.createReversePickup(context);await svc.assignAwb(request,61,sale);
  await assert.rejects(svc.assignAwb(request,61,sale,{reassign:true,reason:'Same courier'}),/different/);
  await assert.rejects(svc.assignAwb(request,62,sale,{reassign:true,reason:'no'}),/reason/);
  remoteStatus='UNKNOWN CARRIER STATE';await assert.rejects(svc.cancel(request,'Courier not attending'),/does not allow/);
  assert.equal(calls.filter(c=>c.method==='post').length,2);
});
test('old courier webhooks cannot overwrite a reassigned AWB or regress a delivered return',async()=>{
  await svc.createReversePickup(context);await svc.assignAwb(request,61,sale);
  await svc.assignAwb(request,62,sale,{reassign:true,reason:'First courier not attending'});
  const {syncReturnTracking}=require('../services/returnTracking');
  const adapter={query:svc.pool.query};
  const event={sr_order_id:91,shipment_id:92,awb:'RETURNTEST',current_status:'RETURN CANCELED'};
  assert.equal((await syncReturnTracking(adapter,event)).processed,0);
  assert.equal((await svc.latest(request)).awb,'RETURNTEST2');
  await syncReturnTracking(adapter,{...event,awb:'RETURNTEST2',current_status:'RETURN DELIVERED'});
  await syncReturnTracking(adapter,{...event,awb:'RETURNTEST2',current_status:'RETURN PICKUP SCHEDULED'});
  assert.equal((await svc.latest(request)).status,'RETURN DELIVERED');
});
test('old cancelled return webhooks cannot change the replacement shipment',async()=>{
  await svc.createReversePickup(context);await svc.assignAwb(request,61,sale);await svc.cancel(request,'Courier did not collect');
  const replacement=(await svc.rebook(context)).reverse;
  const {syncReturnTracking}=require('../services/returnTracking');
  await syncReturnTracking(svc.pool,{sr_order_id:91,shipment_id:92,awb:'RETURNTEST',current_status:'RETURN PICKUP SCHEDULED'});
  assert.equal((await svc.latest(request)).id,replacement.id);assert.equal((await svc.latest(request)).status,'CREATED');
  assert.equal((await db.query('SELECT status FROM reverse_shipments WHERE id=1')).rows[0].status,'RETURN CANCELED');
});
test('a webhook racing with courier reassignment cannot restore the old AWB',async()=>{
  await svc.createReversePickup(context);await svc.assignAwb(request,61,sale);
  const {syncReturnTracking}=require('../services/returnTracking');
  let injected=false;
  const racing={query:async(sql,args)=>{
    const result=await svc.pool.query(sql,args);
    if(!injected&&sql.startsWith('SELECT * FROM reverse_shipments')){
      injected=true;await db.query("UPDATE reverse_shipments SET awb='NEW-RACE-AWB',status='AWB_ASSIGNED' WHERE id=1");
    }
    return result;
  }};
  const result=await syncReturnTracking(racing,{sr_order_id:91,awb:'RETURNTEST',current_status:'RETURN CANCELED'});
  assert.equal(result.processed,0);assert.equal((await svc.latest(request)).awb,'NEW-RACE-AWB');
});
test('returning promotion and regular units of the same variant retains distinct invoice prices and SKUs',async()=>{
  await db.exec("INSERT INTO sale_items VALUES(2,'00000000-0000-4000-8000-000000000001',11,1,1,990,NULL)");
  const payload=await svc.returnPayload({...context,items:[{sale_item_id:1,variant_id:11,qty:1},{sale_item_id:2,variant_id:11,qty:1}]});
  assert.deepEqual(payload.order_items.map(i=>i.selling_price),[500,990]);assert.equal(new Set(payload.order_items.map(i=>i.sku)).size,2);
  assert.equal(payload.sub_total,1490);
});
