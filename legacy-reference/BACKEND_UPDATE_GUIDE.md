# V1Garments backend update

Prepared on 25 September 2026 for mobile app 1.4.0.

The files contain complete code, not patch fragments. JavaScript code comments have been removed. This backend uses the existing store database and preserves the existing catalogue, admin and website routes. A separate mobile database is not required.

## Choose one ZIP

| Archive | Use |
| --- | --- |
| V1Garments-Backend-Complete.zip | Complete backend with runtime files, existing upload assets, tests and configuration. |
| V1Garments-Backend-Updated-Files.zip | Only the 14 replacements and 18 additions needed in the backend you supplied. Merge these contents into your existing project. |

Both archives include this guide, an exact update manifest and an optional .env.example with blank secret values. Keep your actual .env and Vercel environment settings. Do not replace them with the blank template. Do not put the outer ZIP folder inside the existing backend root. Merge its contents so app.js and package.json remain at the project root.

## Required file replacements

| File | Purpose |
| --- | --- |
| `.gitignore` | Keep dependencies, local secrets and deployment metadata out of source control. |
| `api/index.js` | Export the shared Express app through the existing Vercel entry. |
| `app.js` | Mount mobile routes and preserve the raw payment webhook body. |
| `package-lock.json` | Matching dependency lockfile, including local database test dependencies. |
| `package.json` | Local server, mobile tests, schema preflight and migration commands. |
| `routes/cartRoutes.js` | Validate custom clothing against shared server configuration. |
| `routes/productRoutes.js` | Look up an exact product without confusing product and variant IDs. |
| `routes/returnsRoutes.js` | Customer ownership, staff authorization and shared return eligibility. |
| `routes/salesRoutes.js` | Include saved custom artwork in the shared order data. |
| `services/orderShippingWorkflow.js` | Shipping state and confirmed delivery timestamps used by returns. |
| `services/orderStatusSync.js` | Synchronize carrier status without inventing delivery dates. |
| `services/returnsService.js` | Shared eligibility and quantity handling for returns. |
| `services/shiprocketService.js` | Normalize carrier delivery evidence for the shared shipping flow. |
| `tests/orderShipping.test.js` | Shipping idempotency and confirmed delivery timestamp checks. |

## Required new files

| File | Purpose |
| --- | --- |
| `.nvmrc` | Select Node.js 24 for this backend. |
| `migrations/20260923_mobile.sql` | Checkout recovery and account deletion request tables. |
| `migrations/20260923_order_shipping.sql` | Persistent state for the existing shipping workflow. |
| `migrations/20260925_mobile_store.sql` | Addresses, uploads, designs, shared settings and return snapshots. |
| `routes/mobileRoutes.js` | Authenticated cart, wishlist, profile, orders, checkout and account requests. |
| `routes/mobileStoreRoutes.js` | Shared store settings, addresses, customer uploads and saved designs. |
| `routes/mobileWebhook.js` | Verify captured-payment webhook signatures and recover checkout state. |
| `scripts/migrateMobile.js` | Apply all three migrations in one transaction with rollback on failure. |
| `scripts/preflightMobile.js` | Read-only existing-schema and authentication configuration check. |
| `server.js` | Run the shared backend locally with npm start. |
| `services/mobileCheckout.js` | Trusted totals, inventory/rewards transactions and payment recovery. |
| `services/mobileRules.js` | Input validation, trusted prices, quote fingerprints and payment checks. |
| `services/mobileStore.js` | Shared custom garment prices, availability and customer-owned artwork. |
| `services/returnPolicy.js` | Seven-day return window from confirmed delivery, excluding innerwear. |
| `tests/mobileCheckout.test.js` | Authenticated shopping, checkout, payment and ownership checks. |
| `tests/mobileRules.test.js` | Validation, pricing, identity and payment-rule checks. |
| `tests/mobileStore.test.js` | Shared customization, artwork ownership and return-policy checks. |
| `tests/support/mobile-schema.sql` | Local test database fixture, never a production bootstrap. |

Unchanged backend files are included in the complete archive. Their JavaScript is also formatted without code comments. The updated-files archive leaves those existing files alone. vercel.json already forwards requests to api/index.js, so it does not need a change relative to the supplied project.

## Apply locally

Use Node.js 24. Open a terminal inside your existing backend after merging the files.

```bash
npm ci
npm run test:mobile
node --test tests/orderShipping.test.js
```

Keep the existing DATABASE_URL and real JWT_SECRET. Do not change the JWT secret merely to apply this update. The mobile routes intentionally refuse the old development fallback secrets. Existing Razorpay, SMTP, Cloudinary and Shiprocket credentials remain server-side.

| Setting | Purpose |
| --- | --- |
| DATABASE_URL | Existing store PostgreSQL database. |
| JWT_SECRET | Existing configured customer/staff signing secret, not a development fallback. |
| MOBILE_BRANCH_ID | Store branch used by mobile checkout, 3 for this app. |
| MOBILE_FREE_SHIPPING_THRESHOLD / MOBILE_SHIPPING_FEE | Existing store shipping policy. Defaults are 1000 and 75 rupees if unset. Review before accepting orders. |
| MOBILE_RAZORPAY_WEBHOOK_SECRET | Secret configured for the new captured-payment webhook. |
| RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET | Existing server-side payment credentials. |
| CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET | Customer artwork uploads. An explicitly configured unsigned preset is the existing optional alternative. |
| SMTP and Shiprocket settings | Existing email OTP and fulfillment configuration. Retain their current values. |

## Database and deployment order

1. Merge and deploy the matching admin changes first. In particular, src/pages/OrderIssues.js and src/pages/ReturnReview.js must send the staff Bearer token for return/refund requests. The earlier mobile source package contains those files in V1Garments-Admin-Patch. The backend now enforces staff authentication, so publishing it first can break the older admin Returns pages. The latest oversized admin attachment has not been merged or built here.
2. Back up the existing database with your database provider. Test the migration on a staging copy before production. This migration extends your current schema, it does not create the whole store database.
3. From the backend project, with the intended database configured, run the following commands.

```bash
npm run preflight:mobile
npm run migrate:mobile
```

The preflight only reads schema information. The migration command then runs all three SQL files together in one transaction. Do not run tests/support/mobile-schema.sql against your real database. That file is only a test fixture.

4. Deploy this backend to your existing Vercel backend project. The vercel-build command runs preflight only. Deployment does not automatically apply the migrations.
5. Deploy the revised website from the earlier source package after the backend routes respond. Its updated customizer needs /api/mobile/store. Website/app catalogue refresh and shared scene artwork are client changes already included in that package.
6. Verify the endpoints below, then test signup/login, wishlist, cart, saved addresses/designs and a complete test checkout. Use a payment test account before real customer payments.

For local development after configuring the existing environment:

```bash
npm start
```

## Check after deployment

These public GET requests do not create orders or change customer data.

```powershell
curl.exe -i https://vandhana-shopping-mall-backend.vercel.app/healthz
curl.exe -i https://vandhana-shopping-mall-backend.vercel.app/api/mobile/config
curl.exe -i https://vandhana-shopping-mall-backend.vercel.app/api/mobile/store
curl.exe -i https://vandhana-shopping-mall-backend.vercel.app/api/mobile/wishlist
```

The first three should return 200. Wishlist without a customer token should return 401, not 404. A signed-in customer must send Authorization: Bearer followed by their customer token to access their own wishlist/cart/orders. A 503 authentication error means JWT_SECRET is missing or still uses a rejected development value. A store-settings failure after the route is available requires checking the migration and server logs.

Configure the Razorpay payment.captured webhook at:

https://vandhana-shopping-mall-backend.vercel.app/api/mobile/payments/webhook

Use the same webhook secret in the gateway configuration and MOBILE_RAZORPAY_WEBHOOK_SECRET. The webhook uses raw request bytes, so keep its app.js registration before express.json().

## What is shared

Products, stock, photos, banners, customers, wishlist/cart rows and orders use the existing store database. Admin must assign branch-3 inventory, category/gender, price, colour/size and real product photos. A product-master row alone does not provide stock to sell. The app and revised website refresh the same APIs, so they do not need another product upload.

Returns allow seven days from a confirmed delivery timestamp. Innerwear is excluded. Account deletion creates a staff review request rather than immediately erasing customer records.

## Verification and remaining work

The prepared backend passed 34 automated tests: 23 mobile and 11 shipping. Twelve additional checks exercised the actual Vercel entry file, route mounting, private-route rejection and raw-body webhook signature verification. All 58 JavaScript files parse with zero code comments. Their parsed behavior matches the previously prepared backend after formatting.

The test database and payment/shipping integrations use fixtures or mocks. These checks do not prove live OTP delivery, Cloudinary credentials, concurrent production PostgreSQL behavior, real charges or shipping. No production deployment or database migration was executed while preparing these archives.

The existing website cart/wishlist/customer/order routes retain inherited ownership and checkout issues described in KNOWN_LIMITS.md. They need coordinated website/admin changes before claiming that the entire store flow has been verified. Do not remove authentication from the new routes to work around an old caller.
