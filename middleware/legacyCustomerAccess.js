const {requireCustomerAuth}=require('./customerAuth');

function requireOwnCustomerId(req,res,next){
  return requireCustomerAuth(req,res,()=>{
    const match=req.path.match(/^\/(?:count\/)?(\d+)(?:\/clear)?\/?$/);
    const ids=[match?.[1],req.body?.user_id].filter(value=>value!==undefined&&value!==null);
    if(ids.some(value=>Number(value)!==Number(req.customer.id)))return res.status(403).json({message:'This customer account is not yours.'});
    next();
  });
}
module.exports={requireOwnCustomerId};
