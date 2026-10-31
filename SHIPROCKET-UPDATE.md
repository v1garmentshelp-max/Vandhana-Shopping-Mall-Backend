# V1 Garments — returns and courier update

31 October 2026

## Delivery status

The website, admin and backend source packages are updated. These are complete project ZIPs and retain the earlier pricing, rewards, address, COD advance and Razorpay work. No production deployment, production database migration, real payment/refund or real courier booking was performed in this session.

The attached Android APK was inspected but was not modified. An updated APK and signed Android App Bundle (.aab) are not included: the original mobile source project and its release signing configuration were not available. Website edits do not automatically replace a React Native app's screens. Deploying this backend updates shared server rules for clients using it; native screens still need a new app build.

## What changed

- Admin can choose a serviceable return courier, assign an AWB, and request pickup from both the order operations drawer and the return review page.
- Admin can change a courier with a recorded reason. The backend refreshes Shiprocket first, validates the new courier and uses its reassignment API. The old AWB is retained in history and the new pickup is scheduled separately.
- Admin can cancel a return pickup booking. Cancellation of the courier booking leaves the customer's approved return active. Replacement booking is enabled only after Shiprocket confirms cancellation; it uses a new return reference and preserves the old booking.
- Out-for-pickup, picked-up, in-transit, delivered, unknown and conflicting carrier states prevent unsafe booking changes. Shiprocket also enforces its own restrictions. Courier reassignment is limited to once in 24 hours.
- Creation, assignment, reassignment and cancellation timeouts preserve the saved attempt. Refresh/link the existing booking; a second mutation is not blindly sent. Explicitly rejected creation/AWB/pickup requests can be retried after correcting the cause.
- Blocked couriers are excluded. Return serviceability uses the customer's pickup PIN, the original branch warehouse PIN, the stored parcel and prepaid reverse shipping. This remains prepaid reverse shipping even when the original purchase was COD.
- Previous courier webhooks cannot overwrite a new AWB, reopen cancelled attempts, move a delivered return backwards or affect the original forward sale. Concurrent tracking updates use an atomic check. A missing optional return flag does not send a known return event through the forward-order workflow.
- Receipt and inspection are separate from refund processing. Sellable stock restoration is recorded once. COD refunds require confirmed original delivery and a bank/UPI transfer reference; prepaid refunds use the original Razorpay payment. Uncollected COD product balances cannot be refunded.
- Forward cancellation also checks the carrier's shipment status when its order status is stale.
- Website customers see the current return courier/AWB, pending courier changes and replacement-pickup status. An old AWB is hidden while a change is pending or its pickup is cancelled.
- The mobile and website order-return APIs expose matching customer-safe courier fields. Internal carrier payloads and staff notes are excluded from those responses.

The existing policy is preserved: eligible COD merchandise of ₹500 or more adds ₹150 once per order, paid online as an advance. A ₹1,000 dress has a ₹1,150 total: ₹150 advance and ₹1,000 at delivery. Delivery and COD/handling charges remain excluded from product refunds. Reward redemption remains capped at 10% of discounted merchandise value. The Shiwang offer still ended on 20 October 2026.

## Deploy in this order

Use Node.js 24. Each ZIP contains its named project folder. Copy that folder's contents into the corresponding existing repository/project. Preserve the existing private environment settings. Do not replace real values with empty .env.example values.

### 1. Backend database and source

This update requires the additive migration `migrations/20261030_return_couriers.sql`. It adds return booking/courier history fields and an index to the existing reverse_shipments table. It does not change existing order totals, customer balances, stock or prices. Take the usual database backup before applying a production schema update.

From the extracted backend folder, with its existing DATABASE_URL available:

```bat
npm ci
npm run migrate:returns
npm run preflight:commerce
npm run test:operations
```

The migration command uses a transaction and verifies schema readiness before committing. It is safe to rerun. If a readiness check fails, correct the reported database/schema mismatch; do not bypass the deployment check.

Alternatively, open `migrations/20261030_return_couriers.sql` in DBeaver, run the entire file against the same database used by the backend, and commit. Then run `npm run preflight:commerce`. Do not use a different database's successful check as proof that the deployment is ready.

For a new installation missing earlier tables, follow the existing mobile/commerce setup guides first; `npm run migrate:commerce` also includes this new migration. `migrate:returns` alone is for the existing deployed schema.

Deploy the backend to its existing project after the migration. Retain these existing settings:

- DATABASE_URL and JWT_SECRET
- SHIPROCKET_API_USER_EMAIL and SHIPROCKET_API_USER_PASSWORD
- SHIPROCKET_WEBHOOK_TOKEN
- RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and MOBILE_RAZORPAY_WEBHOOK_SECRET
- Existing branch, delivery, email and address settings

The new return flow needs a complete original-branch warehouse mapping: name, street address, city, state, six-digit PIN and phone. Confirm the account's pickup location and wallet balance. Check package measurements before approval; replacement bookings reuse the saved measurements.

Shiprocket webhook URL:

```text
https://vandhana-shopping-mall-backend.vercel.app/api/webhooks/orders
```

Keep its configured token equal to SHIPROCKET_WEBHOOK_TOKEN. This endpoint accepts the token in `x-api-key` or a Bearer Authorization header. The Razorpay webhook remains separate and unchanged.

### 2. Admin

```bat
npm ci
npm test -- --watchAll=false --runInBand
npm run build
```

Deploy to the existing admin project. Output directory: `build`. Keep REACT_APP_API_BASE pointing at the matching backend.

### 3. Website

```bat
npm ci
npm run test:returns
npm run build
```

Deploy to the existing website project. Output directory: `dist`. Keep VITE_API_BASE pointing at the matching backend.

### Git exclusions

The project .gitignore files exclude node_modules, build output and private environment files. Before committing, inspect `git status`. Do not stage node_modules, build, dist, .env, keystores or passwords. The ZIPs exclude dependency folders, generated builds and private .env files.

## Operator workflow

1. Open an order's return in admin. Review selected products and the reason; approve with the checked parcel dimensions.
2. Load return couriers, select one and assign it. Request return pickup after the AWB is confirmed.
3. If the courier does not collect, refresh carrier status. Before out-for-pickup, choose another available courier, enter the reason and confirm the change. Use the new AWB and request the replacement courier's pickup.
4. If cancelling the whole pickup booking is necessary, enter a reason and choose Cancel pickup booking. If confirmation is pending, refresh later. Once confirmed, choose Book replacement pickup, select its courier and request pickup. The original sale and approved return are preserved.
5. If creation timed out, search Shiprocket for the exact saved booking reference, such as RET-7 or RET-7-R1. Link that return's numeric Shiprocket order ID. Do not create an unrelated duplicate in the carrier panel.
6. When products physically arrive, record inspection notes and whether they may re-enter sellable stock. A delivered tracking scan alone does not complete inspection, restock or refund.
7. For prepaid orders, initiate the exact product refund to the original Razorpay payment and check its provider status. For COD, send the approved product refund using the verified customer's bank/UPI details, then record the exact transfer reference. Repeated actions do not restore stock or points twice.

Carrier availability, charges, account permissions and actual pickup timing remain controlled by Shiprocket and the courier. In-flight or uncertain bookings require reconciliation, not forced cancellation.

## Verification completed

176 automated tests passed: 160 backend tests, 10 admin tests and 6 website return-status tests. Both frontend production builds passed. Backend tests use isolated PostgreSQL-compatible PGlite databases and mocked carrier/payment services; advisory-lock behavior is simulated in that harness.

| Area | Checked scenarios |
| --- | --- |
| Return booking | Customer-to-original-warehouse route, dimensions, invoice prices, selected quantities, ambiguous legacy items, mixed promotional and regular units with distinct SKUs |
| Courier selection | Available and blocked couriers, prepaid reverse shipment, required reason, different courier, AWB generation |
| Courier replacement | Old AWB history, cleared old pickup, new pickup request, once-per-24-hour limit, reassignment timeout and reconciliation |
| Cancellation/rebooking | Confirmed versus pending cancellation, duplicate clicks, cancellation timeout, distinct replacement reference, uncertain replacement recovery |
| Carrier state | Out for pickup, picked up, in transit, delivered, unknown status, stale/reordered events, conflicting IDs, webhook/assignment race |
| Permissions | Signed-in customer ownership, staff-only actions, cross-branch denial, competing order-action lock |
| COD/prepaid | ₹150 advance and delivery balance, old-client protections, late capture after cancellation, uncollected COD refund denial, original gateway refund and exact amounts |
| Returns/refunds | Partial quantities, non-refundable fees, reward restoration, physical receipt, stock restoration once, refund retry idempotency and provider-webhook reconciliation |
| Existing features | Offer pricing/expiry, rewards limits, address/PIN services, authentication and checkout regression tests |
| Admin UI | Courier choice, replacement reason, pending cancellation, confirmed replacement, disabled unsafe actions, duplicate click, error display, inspection, COD/prepaid refund paths |
| Website UI | Active courier/AWB, hidden superseded AWB, pending change, cancelled pickup, pickup failures, delivery awaiting inspection, undelivered wording |
| Schema/builds | Additive migration applied twice to isolated databases, old status constraints retained, website and admin production builds |

These results are not a live Shiprocket/Razorpay or physical-device acceptance test. Before serving customers, verify one controlled order of each payment type, a return pickup and courier replacement with your merchant account; confirm webhook delivery, labels/AWB and the exact COD balance. Verify production PostgreSQL concurrency and provider responses with the deployed configuration. No real courier collection or Play Store acceptance was tested here.

The website build reports the existing large-bundle advisory; the admin build reports outdated Browserslist data. Both builds completed successfully.

## Android APK findings and what is still needed

Supplied APK: `V1Garments-Android-Test (5).apk`

| Field | Inspected value |
| --- | --- |
| Package | com.v1garments.mobile |
| Version name / code | 1.5.0 / 6 |
| Minimum / target SDK | 24 / 36 |
| Framework | React Native, Hermes bytecode, with Expo native modules |
| ARM64 libraries | 22; inspected ELF LOAD segments use 16 KB alignment |
| Source project | Not present in the supplied files |
| New APK / signed AAB | Not built |

The ELF inspection is not a device compatibility test, release-signature verification or Play Console approval. The APK's compiled Hermes bundle does not replace the editable React Native project or its signing configuration.

Upload the original mobile source ZIP containing package.json and lockfile, app.json/app.config files, src/ or app/, assets, android/ if maintained, and eas.json if using EAS. Keep signing passwords and private keys in your local/EAS signing setup. Existing Play releases must retain the correct package and signing identity, and the next versionCode must be greater than all versions already uploaded, including this APK's code 6.

The mobile update must use backend quote totals, the 10% reward cap, ₹150 COD advance and remaining balance, PIN-based addresses, server payment verification, order cancellation eligibility, selected return items, current courier status and refund history. Existing native screens cannot be patched by deploying website files.

Customer API contract retained and extended:

```text
GET  /api/mobile/orders/:id/returns
GET  /api/mobile/orders/:id/return-eligibility
POST /api/mobile/orders/:id/return
GET  /api/mobile/orders/:id/cancellation
POST /api/mobile/orders/:id/cancel
GET  /api/mobile/orders/:id/refunds
GET  /api/mobile/orders/:id/timeline
POST /api/mobile/checkout/quote
POST /api/mobile/checkouts
POST /api/mobile/checkouts/:key/pay
POST /api/mobile/checkouts/:key/verify
POST /api/mobile/checkouts/:key/reconcile
```

The return response's `reverse_shipment` adds courier_name, pickup_requested_at, cancelled_at, reassigned_at and pending_action, alongside awb/status/updated_at. Native UI must wait for confirmation and hide the old AWB during a pending change. Courier mutations remain admin-only.

After updating and testing the source, produce a signed release .aab for Play Console, plus an APK for device testing. A maintained native Android project normally builds these through `android\gradlew.bat bundleRelease assembleRelease` from the project root using its configured release signing. An Expo/EAS project must use its existing release profile instead. Those commands were not run here because the source was absent.

Play Console work still includes app signing, testing-track device checks, listing/screenshots, privacy policy, Data safety, content rating, account/deletion disclosures where applicable, app access instructions, and any account-specific testing requirements. Upload through a testing track before production review. Nothing was published to Play Store in this session.

## Primary references checked

- Shiprocket APIs (return creation, courier serviceability, AWB reassignment, pickup and cancellation): https://apidocs.shiprocket.in/
- Return courier reassignment restrictions: https://support.shiprocket.in/support/solutions/articles/43000474417-how-to-reassign-a-return-order-
- Return cancellation restrictions: https://support.shiprocket.in/support/solutions/articles/43000611718-how-to-cancel-a-return-order-
- Google Play target SDK requirements: https://developer.android.com/google/play/requirements/target-sdk
- Android native-library page sizes: https://developer.android.com/guide/practices/page-sizes
- Play app signing: https://support.google.com/googleplay/android-developer/answer/9842756

## Source files changed

### Website

- Created: `tests/return-status.test.cjs`
- Created: `src/components/ReturnShipmentStatus.tsx`
- Modified: `package.json`
- Modified: `src/pages/OrderDetails.tsx`

### Admin

- Created: `src/components/ReturnResolutionControls.jsx`
- Created: `src/components/orderStaffApi.js`
- Created: `src/components/ReturnCourierControls.jsx`
- Created: `src/components/ReturnCourierControls.test.jsx`
- Modified: `src/App.test.js`
- Modified: `src/pages/ReturnReview.js`
- Modified: `src/components/OrderOperations.jsx`
- Modified: `src/components/OrderOperations.css`

### Backend

- Created: `services/returnShippingPolicy.js`
- Created: `scripts/migrateReturnCouriers.js`
- Created: `migrations/20261030_return_couriers.sql`
- Modified: `package.json`
- Modified: `services/orderCancellation.js`
- Modified: `services/storeRefunds.js`
- Modified: `services/returnTracking.js`
- Modified: `services/returnsService.js`
- Modified: `services/orderManagement.js`
- Modified: `services/returnPolicy.js`
- Modified: `routes/mobileRoutes.js`
- Modified: `routes/returnsRoutes.js`
- Modified: `routes/shiprocketRoutes.js`
- Modified: `tests/commerceIntegration.test.js`
- Modified: `tests/shiwangCheckout.test.js`
- Modified: `tests/commerceSchema.test.js`
- Modified: `tests/rewardEmailFix.test.js`
- Modified: `tests/mobileCheckout.test.js`
- Modified: `tests/returnShipping.test.js`
- Modified: `tests/addressIntegration.test.js`
- Modified: `scripts/preflightCommerce.js`
- Modified: `scripts/migrateCommerce.js`

Every project also includes this release guide and an updated notice in UPDATE-INSTRUCTIONS.txt. No existing source files were removed.
