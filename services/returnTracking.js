const {extractShipmentInfo}=require('./orderStatusSync');
async function syncReturnTracking(db,payload) {
  const info=extractShipmentInfo(payload);
  const rows=(await db.query(`SELECT * FROM reverse_shipments WHERE
    ($1::text IS NOT NULL AND awb=$1) OR ($2::text IS NOT NULL AND shiprocket_order_id::text=$2)
    OR ($3::text IS NOT NULL AND shiprocket_shipment_id::text=$3)`,[info.awb,info.shiprocket_order_id,info.shiprocket_shipment_id])).rows;
  let processed=0;
  for(const row of rows){
    if(info.event_at&&row.carrier_event_at&&new Date(info.event_at)<new Date(row.carrier_event_at))continue;
    await db.query(`UPDATE reverse_shipments SET status=COALESCE($2,status),awb=COALESCE($3,awb),
      carrier_event_at=COALESCE($4::timestamptz,carrier_event_at),last_tracking_payload=$5::jsonb,status_synced_at=now(),last_error=NULL
      WHERE id=$1`,[row.id,info.raw_status,info.awb,info.event_at,JSON.stringify(payload)]);
    processed++;
  }
  // A courier scan never substitutes for warehouse inspection or settles a refund.
  return {matched:rows.length,processed};
}
module.exports={syncReturnTracking};
