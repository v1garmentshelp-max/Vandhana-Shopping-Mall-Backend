const Shiprocket = require('./shiprocketService');
const shipping = require('./returnShippingPolicy');
const { addressOf,positiveId,awbText,parcelOf } = require('./shippingValidation');
const fail = (message,status=409)=>Object.assign(new Error(message),{status});

class ReturnsService {
  constructor({pool}) {this.pool=pool;this.sr=new Shiprocket({pool});}
  async init(){await this.sr.init();}
  async returnPayload({request,sale,items,branch,parcel={}}) {
    const wh=(await this.pool.query('SELECT * FROM shiprocket_warehouses WHERE branch_id=$1',[branch.id])).rows[0];
    const address=addressOf(sale);
    if(!wh?.address||!wh.city||!wh.state||!/^\d{6}$/.test(String(wh.pincode)))throw fail('Map a complete branch return address before approving pickup.');
    if(!address.line1||!address.city||!address.state||!/^\d{6}$/.test(address.pincode))throw fail('The customer return pickup address is incomplete.');
    const phone=String(wh.phone||branch.phone||'').replace(/\D/g,'').slice(-10);
    const customerPhone=String(sale.customer_mobile||sale.shipping_address?.mobile||'').replace(/\D/g,'').slice(-10);
    if(!/^[6-9]\d{9}$/.test(customerPhone)||!/^\d{10}$/.test(phone))throw fail('Customer and warehouse phone numbers must be valid before booking a return.');
    const invoice=(await this.pool.query('SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY id',[sale.id])).rows;
    const lines=items.map(item=>{
      const matches=invoice.filter(line=>item.sale_item_id?String(line.id)===String(item.sale_item_id):String(line.variant_id)===String(item.variant_id));
      if(matches.length!==1||!Number.isInteger(Number(item.qty))||Number(item.qty)<=0||Number(item.qty)>Number(matches[0]?.qty)||!(Number(matches[0]?.price)>=0))throw fail('Match each return item to one original invoice item before booking pickup.');
      const line=matches[0];
      return {name:line.custom_title||`Clothing ${line.product_id||line.variant_id}`,sku:invoice.filter(x=>String(x.variant_id)===String(line.variant_id)).length>1?`${line.variant_id||'item'}-${line.id}`:String(line.variant_id||line.id),units:Number(item.qty),selling_price:Number(line.price)};
    });
    if(!lines.length)throw fail('Select the returned products before booking pickup.');
    const dimensions=parcelOf(parcel);
    const payload={order_id:`RET-${request.id}`,order_date:new Date(request.created_at||Date.now()).toISOString().slice(0,19).replace('T',' '),
      pickup_customer_name:sale.customer_name||sale.shipping_address?.fullName||'Customer',pickup_last_name:'',
      pickup_address:address.line1,pickup_address_2:address.line2,pickup_city:address.city,pickup_state:address.state,pickup_country:'India',
      pickup_pincode:address.pincode,pickup_email:sale.customer_email||sale.login_email,pickup_phone:customerPhone,
      shipping_customer_name:wh.name||branch.name,shipping_last_name:'',shipping_address:wh.address,shipping_address_2:'',
      shipping_city:wh.city,shipping_state:wh.state,shipping_country:'India',shipping_pincode:String(wh.pincode),shipping_phone:phone,
      ...(branch.email?{shipping_email:branch.email}:{}),order_items:lines,payment_method:'Prepaid',
      sub_total:Number(lines.reduce((sum,item)=>sum+item.units*item.selling_price,0).toFixed(2)),...dimensions};
    if(!payload.pickup_email)throw fail('The customer email is needed to book a return.');
    return payload;
  }
  async latest(request) {
    return (await this.pool.query('SELECT * FROM reverse_shipments WHERE request_id=$1 ORDER BY id DESC LIMIT 1', [request.id])).rows[0];
  }
  async createReversePickup(context) {
    const {request} = context;
    let saved = await this.latest(request);
    if (saved && !saved.cancelled_at && saved.status !== 'BOOKING_FAILED') throw fail('A return booking already exists or awaits reconciliation. Refresh or link it before continuing.');
    const parcel = context.parcel && Object.keys(context.parcel).length ? context.parcel : saved?.parcel || {};
    const payload = await this.returnPayload({...context, parcel});
    payload.order_id = saved?.status === 'BOOKING_FAILED' ? saved.booking_reference : saved ? `RET-${request.id}-R${saved.id}` : `RET-${request.id}`;
    if (saved?.status === 'BOOKING_FAILED') {
      saved = (await this.pool.query("UPDATE reverse_shipments SET status='CREATING',parcel=$2::jsonb,last_error=NULL WHERE id=$1 RETURNING *", [saved.id, JSON.stringify({...parcelOf(parcel),declared_value:payload.sub_total})])).rows[0];
    } else {
      saved = (await this.pool.query("INSERT INTO reverse_shipments(request_id,booking_reference,parcel,status) VALUES($1,$2,$3::jsonb,'CREATING') RETURNING *", [request.id, payload.order_id, JSON.stringify({...parcelOf(parcel),declared_value:payload.sub_total})])).rows[0];
    }
    try {
      const {data} = await this.sr.api('post', '/orders/create/return', payload);
      const orderId = positiveId(data?.order_id), shipmentId = positiveId(Array.isArray(data?.shipment_id) ? data.shipment_id[0] : data?.shipment_id);
      if (!orderId || !shipmentId) throw fail('Shiprocket did not confirm the return IDs. Find the saved return reference in Shiprocket and link its order ID.');
      return (await this.pool.query("UPDATE reverse_shipments SET shiprocket_order_id=$2,shiprocket_shipment_id=$3,awb=$4,status='CREATED',last_error=NULL WHERE id=$1 RETURNING *", [saved.id,orderId,shipmentId,awbText(data.awb_code)])).rows[0];
    } catch (e) {
      await this.pool.query('UPDATE reverse_shipments SET status=$2,last_error=$3 WHERE id=$1', [saved.id, this.rejected(e) ? 'BOOKING_FAILED' : 'BOOKING_REVIEW', String(e.message).slice(0,1000)]);
      throw e;
    }
  }
  rejected(e) { return [400,401,403,422].includes(Number(e?.status)); }
  async reconcile(request, remoteId) {
    let saved = await this.latest(request);
    const id = positiveId(remoteId || saved?.shiprocket_order_id);
    if (!id) throw fail('Enter the numeric Shiprocket return order ID to reconcile the saved booking.',400);
    if (saved?.shiprocket_order_id && String(saved.shiprocket_order_id) !== id) throw fail('A different return order is already linked. Cancel and confirm that booking before creating another.');
    const {data} = await this.sr.api('get', `/orders/show/${id}`);
    const remote = data?.data;
    if (!remote || (remote.id != null && String(remote.id) !== id) || String(remote.channel_order_id) !== (saved?.booking_reference || `RET-${request.id}`)) throw fail('This carrier return does not match the selected return request and booking reference.');
    const shipments = Array.isArray(remote.shipments) ? remote.shipments : remote.shipments ? [remote.shipments] : [];
    const active = shipments.filter(s => !shipping.cancelled(s.status));
    const shipment = shipments.length === 1 ? shipments[0] : active.length === 1 ? active[0] : shipping.cancelled(remote.status) ? shipments.find(s => String(s.id) === saved?.shiprocket_shipment_id) : null;
    if (!shipment || !positiveId(shipment.id)) throw fail('The carrier return has ambiguous shipment records. Review it in Shiprocket before continuing.');
    const conflict = (await this.pool.query('SELECT request_id FROM reverse_shipments WHERE (shiprocket_order_id=$1 OR shiprocket_shipment_id=$3) AND request_id<>$2 LIMIT 1', [id,request.id,String(shipment.id)])).rows[0];
    if (conflict) throw fail('This carrier return is already linked to another request.');
    if (!saved) saved = (await this.pool.query("INSERT INTO reverse_shipments(request_id,booking_reference,shiprocket_order_id,shiprocket_shipment_id,status) VALUES($1,$2,$3,$4,'CREATED') RETURNING *", [request.id,`RET-${request.id}`,id,String(shipment.id)])).rows[0];
    const awb = awbText(shipment.awb || shipment.awb_code);
    const courierId = positiveId(shipment.courier_id || shipment.courier_company_id || remote.courier_id);
    const carrierStatus = shipping.cancelled(remote.status) || shipping.movement(remote.status)>shipping.movement(shipment.status) ? String(remote.status) : (typeof shipment.status === 'string' && !/^\d+$/.test(shipment.status) ? shipment.status : String(remote.status || saved.status));
    const isCancelled = shipping.cancelled(remote.status);
    if (isCancelled && shipping.movement(shipment.status)>0 && !shipping.cancelled(shipment.status)) throw fail('The carrier cancellation conflicts with a pickup or movement scan. Review the original booking before replacing it.');
    if (saved.cancelled_at && !isCancelled) throw fail('The carrier cancellation status is inconsistent. Review the original booking before replacing it.');
    if (shipping.movement(saved.status)>=2 && !shipping.acceptsStatus(saved.status,carrierStatus)) throw fail('The carrier status would move a completed or moving return backwards. Review its latest tracking.');
    const changed = !!awb && !!saved.awb && awb !== saved.awb;
    const op = saved.operation;
    let operation = op;
    if (op?.type === 'CANCEL' && isCancelled) operation = null;
    if (['REASSIGN','ASSIGN'].includes(op?.type) && awb && awb !== op.previous_awb && courierId === String(op.courier_id)) operation = null;
    const history = Array.isArray(saved.awb_history) ? [...saved.awb_history] : [];
    if (changed) history.push({awb:saved.awb,courier_id:saved.courier_id,courier_name:saved.courier_name,changed_at:new Date().toISOString()});
    const scheduled = require('./orderStatusSync').carrierDate(shipment.pickup_scheduled_date || shipment.pickup_scheduled_at);
    const reconciled = (await this.pool.query(`UPDATE reverse_shipments SET shiprocket_order_id=$2,shiprocket_shipment_id=$3,
      awb=COALESCE($4,awb),courier_id=COALESCE($5,courier_id),courier_name=COALESCE($6,courier_name),status=$7,
      status_synced_at=now(),last_tracking_payload=$8::jsonb,operation=$9::jsonb,awb_history=$10::jsonb,
      cancelled_at=CASE WHEN $11 THEN COALESCE(cancelled_at,now()) ELSE cancelled_at END,
      reassigned_at=CASE WHEN $12 THEN now() ELSE reassigned_at END,
      pickup_requested_at=CASE WHEN $13 THEN $14::timestamptz ELSE COALESCE($14::timestamptz,pickup_requested_at) END,
      pickup_attempted=CASE WHEN $13 THEN $14::timestamptz IS NOT NULL ELSE pickup_attempted END,
      carrier_event_at=CASE WHEN $13 THEN now() ELSE carrier_event_at END,
      last_error=CASE WHEN $9::jsonb IS NULL THEN NULL ELSE last_error END WHERE id=$1 AND status IS NOT DISTINCT FROM $15 AND awb IS NOT DISTINCT FROM $16
      AND carrier_event_at IS NOT DISTINCT FROM $17::timestamptz RETURNING *`,
      [saved.id,id,String(shipment.id),awb,courierId,shipment.courier_name || shipment.courier || null,carrierStatus,JSON.stringify(remote),operation ? JSON.stringify(operation) : null,JSON.stringify(history),isCancelled,op?.type === 'REASSIGN' && !operation,changed,scheduled,saved.status,saved.awb,saved.carrier_event_at])).rows[0];
    if (!reconciled) throw fail('Return tracking changed while checking the carrier. Refresh before another action.');
    return reconciled;
  }
  assertEditable(reverse) {
    if (reverse.cancelled_at || !shipping.editable(reverse.status)) throw fail('The carrier status does not allow this action. Out for pickup, moving, delivered and cancelled returns cannot be changed. Refresh carrier status.');
    if (reverse.operation) throw fail('A carrier change is awaiting confirmation. Refresh carrier status before starting another action.');
  }
  async available(reverse,sale) {
    const wh = (await this.pool.query('SELECT * FROM shiprocket_warehouses WHERE branch_id=$1',[sale.branch_id])).rows[0];
    const address = addressOf(sale);
    const remote = reverse.last_tracking_payload || {};
    if (!/^\d{6}$/.test(address.pincode) || !/^\d{6}$/.test(String(wh?.pincode || ''))) throw fail('Customer and warehouse PIN codes are required for return courier selection.');
    const {data} = await this.sr.api('get','/courier/serviceability/',{pickup_postcode:address.pincode,delivery_postcode:String(wh.pincode),order_id:Number(reverse.shiprocket_order_id),is_return:1,cod:0,declared_value:Number(reverse.parcel?.declared_value ?? remote.total ?? remote.sub_total ?? 0),weight:Number(reverse.parcel?.weight || 0.5)});
    return (data?.data?.available_courier_companies || []).filter(c => ![true,1,'1','true'].includes(c.blocked));
  }
  async couriers(request,sale) {
    const reverse = await this.reconcile(request);
    this.assertEditable(reverse);
    return {couriers:await this.available(reverse,sale),reverse:{...reverse,actions:shipping.actions(reverse)}};
  }
  async assignAwb(request,courierId,sale,{reassign=false,reason=''}={}) {
    let reverse = await this.reconcile(request);
    if (!reassign && reverse.awb && !reverse.operation && !reverse.cancelled_at) return {ok:true,reverse};
    this.assertEditable(reverse);
    if (!positiveId(courierId)) throw fail('Select an available reverse courier.',400);
    if (reassign) {
      if (!reverse.awb) throw fail('Assign the first return courier before changing it.');
      if (String(reverse.courier_id) === String(courierId)) throw fail('Choose a different courier partner.',400);
      if (String(reason).trim().length < 5) throw fail('Enter a reason for changing the return courier.',400);
      if (reverse.reassigned_at && Date.now()-new Date(reverse.reassigned_at).getTime()<86400000) throw fail('Shiprocket allows a courier reassignment only once in 24 hours. Try after the saved reassignment time.');
    } else if (reverse.awb_attempted) throw fail('A return AWB may already be assigned. Refresh carrier status and check Shiprocket before retrying.');
    const chosen = (await this.available(reverse,sale)).find(c => String(c.courier_company_id) === String(courierId));
    if (!chosen) throw fail('This courier is unavailable for the customer return pickup.');
    const operation = {type:reassign?'REASSIGN':'ASSIGN',courier_id:String(courierId),previous_awb:reverse.awb || null,reason:String(reason).trim().slice(0,1000),started_at:new Date().toISOString()};
    await this.pool.query('UPDATE reverse_shipments SET awb_attempted=true,operation=$2::jsonb WHERE id=$1',[reverse.id,operation?JSON.stringify(operation):null]);
    let data;
    try {
      ({data} = await this.sr.api('post','/courier/assign/awb',{shipment_id:Number(reverse.shiprocket_shipment_id),courier_id:Number(courierId),is_return:1,...(reassign?{status:'reassign'}:{})}));
      if (Number(data?.awb_assign_status) === 0) throw Object.assign(fail(typeof data?.message==='string'?data.message:'Shiprocket rejected the courier assignment. Check availability and wallet balance.'),{definite:true});
    } catch(e) {
      if (e.definite || this.rejected(e)) await this.pool.query('UPDATE reverse_shipments SET awb_attempted=$2,operation=NULL WHERE id=$1',[reverse.id,!!reverse.awb]);
      throw e;
    }
    const awb = awbText(data?.response?.data?.awb_code);
    const assigned = positiveId(data?.response?.data?.courier_company_id || data?.response?.data?.courier_id);
    if (!awb || Number(data?.awb_assign_status)!==1 || (assigned && assigned!==String(courierId)) || (reassign && awb===reverse.awb)) throw fail('Return AWB confirmation is pending. Refresh carrier status; another assignment will not be sent.');
    const history = [...(reverse.awb_history || [])];
    if (reassign) history.push({awb:reverse.awb,courier_id:reverse.courier_id,courier_name:reverse.courier_name,reason:operation.reason,changed_at:new Date().toISOString()});
    reverse = (await this.pool.query(`UPDATE reverse_shipments SET awb=$2,courier_id=$3,courier_name=$4,status='AWB_ASSIGNED',
      operation=NULL,last_error=NULL,awb_history=$5::jsonb,pickup_attempted=false,pickup_requested_at=NULL,
      reassigned_at=CASE WHEN $6 THEN now() ELSE reassigned_at END,carrier_event_at=now() WHERE id=$1 RETURNING *`,[reverse.id,awb,String(courierId),chosen.courier_name,JSON.stringify(history),reassign])).rows[0];
    return {ok:true,reverse};
  }
  async cancel(request,reason) {
    let reverse = await this.reconcile(request);
    if (reverse.cancelled_at) return {ok:true,confirmed:true,reverse};
    if (reverse.operation?.type !== 'CANCEL') {
      this.assertEditable(reverse);
      if (String(reason || '').trim().length < 5) throw fail('Enter the reason for cancelling this return pickup.',400);
      const op={type:'CANCEL',reason:String(reason).trim().slice(0,1000),started_at:new Date().toISOString()};
      await this.pool.query('UPDATE reverse_shipments SET operation=$2::jsonb,cancellation_reason=$3 WHERE id=$1',[reverse.id,JSON.stringify(op),op.reason]);
      try { await this.sr.api('post','/orders/cancel',{ids:[Number(reverse.shiprocket_order_id)]}); }
      catch(e) {
        if (this.rejected(e)) await this.pool.query('UPDATE reverse_shipments SET operation=NULL WHERE id=$1',[reverse.id]);
        throw e;
      }
    }
    reverse = await this.reconcile(request);
    return {ok:true,confirmed:!!reverse.cancelled_at,reverse,message:reverse.cancelled_at?'Return pickup cancelled. The customer return remains approved.':'Cancellation is awaiting carrier confirmation. Refresh before booking another pickup.'};
  }
  async rebook(context) {
    const saved = await this.latest(context.request);
    if (saved?.status==='BOOKING_FAILED') return {ok:true,reverse:await this.createReversePickup(context)};
    const reverse = await this.reconcile(context.request);
    if (!reverse.cancelled_at || reverse.operation) throw fail('Wait for confirmed carrier cancellation before booking a replacement pickup.');
    return {ok:true,reverse:await this.createReversePickup(context)};
  }
  async pickup(request) {
    const reverse = await this.reconcile(request);
    this.assertEditable(reverse);
    if (reverse.pickup_requested_at) return {ok:true,reverse};
    if (!reverse.awb) throw fail('Generate the return AWB before requesting pickup.');
    if (reverse.pickup_attempted) throw fail('A return pickup may already be scheduled. Check Shiprocket and reconcile this booking.');
    await this.pool.query('UPDATE reverse_shipments SET pickup_attempted=true WHERE id=$1',[reverse.id]);
    let data;
    try {
      ({data} = await this.sr.api('post','/courier/generate/pickup',{shipment_id:[Number(reverse.shiprocket_shipment_id)]}));
      if (Number(data?.pickup_status)===0) throw Object.assign(fail('Shiprocket rejected the pickup. Check its response and try again.'),{definite:true});
    } catch(e) {
      if (e.definite || this.rejected(e)) await this.pool.query('UPDATE reverse_shipments SET pickup_attempted=false WHERE id=$1',[reverse.id]);
      throw e;
    }
    if (Number(data?.pickup_status)!==1) throw fail('Return pickup confirmation is pending. Check the saved return booking in Shiprocket.');
    return {ok:true,reverse:(await this.pool.query("UPDATE reverse_shipments SET pickup_requested_at=now(),status='PICKUP_REQUESTED',last_error=NULL WHERE id=$1 RETURNING *",[reverse.id])).rows[0]};
  }
}
module.exports=ReturnsService;
