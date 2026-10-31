const {extractShipmentInfo}=require('./orderStatusSync');
const {acceptsStatus}=require('./returnShippingPolicy');
async function syncReturnTracking(db,payload) {
  const info=extractShipmentInfo(payload);
  const rows=(await db.query(`SELECT * FROM reverse_shipments WHERE
    ($1::text IS NOT NULL AND awb=$1) OR ($2::text IS NOT NULL AND shiprocket_order_id::text=$2)
    OR ($3::text IS NOT NULL AND shiprocket_shipment_id::text=$3)`,[info.awb,info.shiprocket_order_id,info.shiprocket_shipment_id])).rows;
  let processed=0;
  for(const row of rows){
    if(info.awb&&row.awb&&String(info.awb)!==String(row.awb))continue;
    if(info.shiprocket_order_id&&row.shiprocket_order_id&&String(info.shiprocket_order_id)!==String(row.shiprocket_order_id))continue;
    if(info.shiprocket_shipment_id&&row.shiprocket_shipment_id&&String(info.shiprocket_shipment_id)!==String(row.shiprocket_shipment_id))continue;
    if(row.operation||!acceptsStatus(row.status,info.raw_status,info.event_at,row.carrier_event_at))continue;
    const updated=await db.query(`UPDATE reverse_shipments SET status=COALESCE($2,status),awb=COALESCE($3,awb),
      carrier_event_at=COALESCE($4::timestamptz,carrier_event_at),last_tracking_payload=$5::jsonb,status_synced_at=now(),last_error=NULL
      WHERE id=$1 AND awb IS NOT DISTINCT FROM $6 AND status IS NOT DISTINCT FROM $7 AND operation IS NULL
      AND carrier_event_at IS NOT DISTINCT FROM $8::timestamptz RETURNING id`,[row.id,info.raw_status,info.awb,info.event_at,JSON.stringify(payload),row.awb,row.status,row.carrier_event_at]);
    processed+=updated.rows.length;
  }
                                                                                   
  return {matched:rows.length,processed};
}
module.exports={syncReturnTracking};
