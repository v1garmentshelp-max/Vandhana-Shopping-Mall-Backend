const Shiprocket = require('./shiprocketService');
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
      return {name:line.custom_title||`Clothing ${line.product_id||line.variant_id}`,sku:String(line.variant_id||line.id),units:Number(item.qty),selling_price:Number(line.price)};
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
  async createReversePickup(context) {
    const {request}=context;
    const payload=await this.returnPayload(context);
    const {data}=await this.sr.api('post','/orders/create/return',payload);
    const orderId=positiveId(data?.order_id),shipmentId=positiveId(Array.isArray(data?.shipment_id)?data.shipment_id[0]:data?.shipment_id);
    if(!orderId||!shipmentId)throw fail('Shiprocket did not confirm a reverse order and shipment ID. Check its returns panel before retrying.');
    // Save before any AWB/pickup action so those steps can be recovered separately.
    return (await this.pool.query(`INSERT INTO reverse_shipments(request_id,shiprocket_order_id,shiprocket_shipment_id,awb,status)
      VALUES($1,$2,$3,$4,'CREATED') RETURNING *`,[request.id,orderId,shipmentId,awbText(data.awb_code)])).rows[0];
  }
  async reconcile(request,remoteId) {
    const saved=(await this.pool.query('SELECT * FROM reverse_shipments WHERE request_id=$1 ORDER BY id DESC LIMIT 1',[request.id])).rows[0];
    const id=positiveId(remoteId||saved?.shiprocket_order_id);
    if(!id)throw fail('Enter the numeric Shiprocket return order ID.',400);
    const {data}=await this.sr.api('get',`/orders/show/${id}`);
    const remote=data?.data;
    if(String(remote?.channel_order_id)!==`RET-${request.id}`)throw fail('This carrier return does not match the selected return request.');
    const shipments=Array.isArray(remote.shipments)?remote.shipments:remote.shipments?[remote.shipments]:[];
    if(shipments.length!==1||!positiveId(shipments[0].id))throw fail('The carrier return shipment needs manual review.');
    const conflict=(await this.pool.query('SELECT request_id FROM reverse_shipments WHERE shiprocket_order_id=$1 AND request_id<>$2 LIMIT 1',[id,request.id])).rows[0];
    if(conflict)throw fail('This carrier return is already linked to another request.');
    const awb=awbText(shipments[0].awb||shipments[0].awb_code);
    if(!saved)return (await this.pool.query(`INSERT INTO reverse_shipments(request_id,shiprocket_order_id,shiprocket_shipment_id,awb,status)
      VALUES($1,$2,$3,$4,$5) RETURNING *`,[request.id,id,String(shipments[0].id),awb,String(remote.status||'CREATED')])).rows[0];
    if(String(saved.shiprocket_order_id)!==id)throw fail('A different return order is already linked. Review it before replacing the booking.');
    const pickupScheduled=shipments[0].pickup_scheduled_date||shipments[0].pickup_scheduled_at;
    return (await this.pool.query(`UPDATE reverse_shipments SET awb=COALESCE($2,awb),status=$3,status_synced_at=now(),
      last_tracking_payload=$4::jsonb,last_error=NULL,pickup_requested_at=COALESCE(pickup_requested_at,$5::timestamptz) WHERE id=$1 RETURNING *`,
      [saved.id,awb,String(remote.status||saved.status),JSON.stringify(remote),require('./orderStatusSync').carrierDate(pickupScheduled)])).rows[0];
  }
  async couriers(request,sale) {
    const reverse=await this.reconcile(request);
    const wh=(await this.pool.query('SELECT * FROM shiprocket_warehouses WHERE branch_id=$1',[sale.branch_id])).rows[0];
    const {data}=await this.sr.api('get','/courier/serviceability/',{pickup_postcode:addressOf(sale).pincode,delivery_postcode:String(wh?.pincode||''),order_id:Number(reverse.shiprocket_order_id),is_return:1});
    return {couriers:data?.data?.available_courier_companies||[]};
  }
  async assignAwb(request,courierId,sale) {
    let reverse=await this.reconcile(request);
    if(reverse.awb)return {ok:true,reverse};
    if(reverse.awb_attempted)throw fail('A return AWB may already be assigned. Refresh carrier status and check Shiprocket before retrying.');
    if(!positiveId(courierId))throw fail('Select an available reverse courier.',400);
    const available=(await this.couriers(request,sale)).couriers;
    if(!available.some(item=>String(item.courier_company_id)===String(courierId)))throw fail('This courier is unavailable for the customer return pickup.');
    await this.pool.query('UPDATE reverse_shipments SET awb_attempted=true WHERE id=$1',[reverse.id]);
    const {data}=await this.sr.api('post','/courier/assign/awb',{shipment_id:Number(reverse.shiprocket_shipment_id),courier_id:Number(courierId),is_return:1});
    const awb=awbText(data?.response?.data?.awb_code);
    if(!awb||Number(data?.awb_assign_status)!==1)throw fail('Return AWB confirmation is pending. Check and reconcile the saved booking.');
    reverse=(await this.pool.query("UPDATE reverse_shipments SET awb=$2,status='AWB_ASSIGNED',last_error=NULL WHERE id=$1 RETURNING *",[reverse.id,awb])).rows[0];
    return {ok:true,reverse};
  }
  async pickup(request) {
    const reverse=await this.reconcile(request);
    if(reverse.pickup_requested_at)return {ok:true,reverse};
    if(!reverse.awb)throw fail('Generate the return AWB before requesting pickup.');
    if(reverse.pickup_attempted)throw fail('A return pickup may already be scheduled. Check Shiprocket and reconcile this booking.');
    await this.pool.query('UPDATE reverse_shipments SET pickup_attempted=true WHERE id=$1',[reverse.id]);
    const {data}=await this.sr.api('post','/courier/generate/pickup',{shipment_id:[Number(reverse.shiprocket_shipment_id)]});
    if(Number(data?.pickup_status)!==1)throw fail('Return pickup confirmation is pending. Check the saved return booking in Shiprocket.');
    return {ok:true,reverse:(await this.pool.query("UPDATE reverse_shipments SET pickup_requested_at=now(),status='PICKUP_REQUESTED',last_error=NULL WHERE id=$1 RETURNING *",[reverse.id])).rows[0]};
  }
}
module.exports=ReturnsService;
