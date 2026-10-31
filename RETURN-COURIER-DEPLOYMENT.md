# Return courier database fix

The Vercel failure reporting missing columns on public.reverse_shipments requires the committed migrations/20261030_return_couriers.sql file to be applied to the same database used by the Vercel backend.

With the correct production DATABASE_URL in the private .env or environment, after a database backup:

```bat
npm ci
npm run migrate:returns
npm run preflight:commerce
npm run vercel-build
```

Then deploy the backend. The migration command commits on success and rolls back if readiness checks fail. It adds the nine courier-booking fields and index without changing customer/order amounts or existing shipments. Do not remove the read-only preflight.

Alternatively, run the entire migration in DBeaver on that exact connection and commit before redeploying. The full release guide describes admin courier assignment, confirmed cancellation/rebooking, refunds, mobile 1.6.0 builds and deployment acceptance checks.
