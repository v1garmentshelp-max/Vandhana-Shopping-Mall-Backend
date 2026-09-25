# Existing integration limits

The new mobile routes scope private data to the signed-in customer and use server-validated checkout totals. Some inherited website routes need a coordinated update of their callers before the whole store can be considered verified.

| Existing area | Remaining issue |
| --- | --- |
| routes/cartRoutes.js and routes/wishlistRoutes.js | Legacy public routes accept a customer ID supplied by the caller without enforcing that customer's session. The new mobile routes wrap access with ownership checks. |
| routes/userRoutes.js | Existing email lookup and mobile update routes lack customer ownership enforcement. |
| routes/orderRoutes.js | Legacy web placement accepts client totals. Cancellation lacks customer authentication and coordinated stock/reward restoration. |
| routes/salesRoutes.js | Legacy web placement still accepts client price/total data. |
| Website payment caller | The supplied website calls /api/payments/create-order with a cart, while its legacy backend exposes /api/razorpay/create-order with a saved sale_id. Its success navigation also differs from the registered routes. Mobile checkout uses the new endpoints. |
| Abandoned/uncertain payments | Staff reconciliation is still required for uncertain remote order creation. There is no automatic expiry and stock/reward restoration worker. |
| Returns admin | Existing callers must include the staff Authorization header before the revised backend is deployed. |

These are specific inherited release issues, not evidence that customer data was accessed. No production customer transaction or payment was performed for this handoff.
