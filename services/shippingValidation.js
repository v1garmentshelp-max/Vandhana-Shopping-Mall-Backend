const positiveId=value=>/^\d+$/.test(String(value||''))&&Number(value)>0?String(value):null;
const awbText=value=>typeof value==='string'&&/^[A-Za-z0-9-]+$/.test(value)&&!['null','undefined'].includes(value)?value:null;
const addressOf=sale=>{
  const a=sale.shipping_address||{};
  return {line1:String(a.line1||a.address_line1||a.address1||a.street||'').trim(),
    line2:String(a.line2||a.address_line2||a.address2||a.landmark||'').trim(),city:String(a.city||'').trim(),
    state:String(a.state||'').trim(),pincode:String(a.pincode||a.pin_code||sale.pincode||'').trim()};
};
const parcelOf=(parcel={})=>{
  if(!parcel||typeof parcel!=='object'||Array.isArray(parcel))throw Object.assign(new Error('Enter valid measured package dimensions and weight.'),{status:422});
  const values={weight:Number(parcel.weight??process.env.SHIPROCKET_DEFAULT_WEIGHT_KG??0.5),
    length:Number(parcel.length??process.env.SHIPROCKET_DEFAULT_LENGTH_CM??10),
    breadth:Number(parcel.breadth??process.env.SHIPROCKET_DEFAULT_BREADTH_CM??10),
    height:Number(parcel.height??process.env.SHIPROCKET_DEFAULT_HEIGHT_CM??5)};
  if(Object.values(values).some(value=>!Number.isFinite(value)||value<=0))throw Object.assign(new Error('Enter valid measured package dimensions and weight.'),{status:422});
  return values;
};
module.exports={positiveId,awbText,addressOf,parcelOf};
