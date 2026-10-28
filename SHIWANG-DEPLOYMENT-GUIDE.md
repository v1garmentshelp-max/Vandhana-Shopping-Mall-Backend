CURRENT UPDATE: Read COD-ADVANCE-UPDATE.txt first. Payment rules, pricing examples and validation results below describe earlier releases and are superseded by that guide where they differ. The Shiwang offer has not been extended beyond 20 October 2026.

# Shiwang offer — deployment guide

Prepared for V1 Garments on 15 October 2026.

## Offer applied

Eligible items: **Shiwang → Women → Kurthi Pant Set**, including child categories and Kurti/Kurta spelling variants. Brand matching is exact after case/spacing normalization. Other brands, unrelated categories, custom garments, wholesale and POS prices are unaffected.

| Eligible sets in one retail order | Merchandise total | Pair savings against ₹990 each |
| --- | ---: | ---: |
| 1 | ₹990 | ₹0 |
| 2 | ₹1,599 | ₹381 |
| 3 | ₹2,589 | ₹381 |
| 4 | ₹3,198 | ₹762 |
| 5 | ₹4,188 | ₹762 |
| 6 | ₹4,797 | ₹1,143 |
| 7 | ₹5,787 | ₹1,143 |
| 8 | ₹6,396 | ₹1,524 |

Formula: `floor(quantity / 2) × 1599 + (quantity % 2) × 990`.

Mix eligible designs, colours and sizes. No coupon code is required. Current product-level percentage discounts are replaced by this campaign price for eligible sets while active; pair savings are not subtracted twice. Existing reward redemption remains available. Existing delivery and COD policies apply to the discounted product subtotal, before rewards. These charges are additional to the merchandise totals above.

**Validity:** 15 October 2026, 00:00:00 IST through 20 October 2026, 23:59:59 IST. The exclusive cutoff is `2026-10-21T00:00:00+05:30` (`2026-10-20T18:30:00Z`). The backend enforces the date; no cron job is needed. Product catalogue prices remain stored unchanged and are used again after expiry. Already-created orders retain their saved amount. A cart quote that crosses the cutoff must be refreshed before a new order is accepted.

## Files to deploy

- `vandhana-backend.zip`: updated pricing, product eligibility metadata, public offer endpoint, authenticated admin offer endpoint, shipping line handling, tests and database checks.
- `vandhana-website.zip`: offer banner, Shiwang collection, product offer labels, server-priced cart, checkout, saved-order promotion summary, full build configuration and assets.
- `vandhana-admin.zip`: Shiwang Offer page and navigation, matching-variant/stock audit, and offer savings on order details.

The ZIPs each contain their named project folder. Unzip them separately and use those folders as the project roots. Source files and lockfiles are included. `node_modules`, generated builds and credentials are excluded.

## 1. Backend first

Use Node.js 24, matching the existing backend project. Keep your existing production environment values. Do not overwrite real credentials with `.env.example` placeholders.

From the extracted `vandhana-backend` folder:

```bash
npm ci
npm run test:offers
npm run preflight:shiwang
npm run preflight:commerce
```

The preflight commands need your existing `DATABASE_URL` in the environment or a local `.env`. `preflight:shiwang` is read-only and lists the eligible variants in `MOBILE_BRANCH_ID` (default 3). It does not change prices, stock, orders or schema.

Deploy these backend files to your existing backend project, retaining its domain and existing database, JWT, payment and shipping settings. Existing Vercel preflight gates are retained. For a local server use `npm start` after environment setup.

New optional environment setting:

```dotenv
SHIWANG_OFFER_ENABLED=true
```

The offer is enabled by default within its fixed dates. To stop it early, set this value to `false` in the backend environment and redeploy. Expiry is automatic even if it remains `true`. Do not use this flag to extend the campaign; dates are in `services/shiwangOffer.js`.

Read-only production checks after deployment:

- `GET /api/storefront/offers` must report `SHIWANG_PAIR_OCT2026` with the expected dates and `ACTIVE` status during the campaign.
- `GET /api/products?brand=shiwang&branch_id=3&group_by=color` must include an `offer` object on eligible products.

## 2. Website

From the extracted `vandhana-website` folder:

```bash
npm ci
npm run build
```

Deploy to the existing website project/domain. Build command: `npm run build`. Output directory: `dist`. Use Node.js 24 (the supplied configuration also supports Node >=22.12).

Set `VITE_API_BASE` to your existing backend URL if it differs from the current default:

```dotenv
VITE_API_BASE=https://vandhana-shopping-mall-backend.vercel.app
```

The site's offer page is `/offers/shiwang`. The homepage/banner, eligible product cards and detail pages lead customers into the same offer. Cart and checkout totals come from the backend. If a quote fails, checkout is blocked until pricing is refreshed.

The uploaded website ZIP contained only `src` and omitted the build manifest, public files and imported image assets. This package includes a working Vite/TypeScript/Tailwind build setup and the image assets recovered from the live V1 Garments deployment. Missing social icons use the existing react-icons dependency. A few unused legacy illustration imports have local fallbacks so a clean build succeeds. Keep any additional original assets/configuration that your own repository requires.

## 3. Admin

From the extracted `vandhana-admin` folder:

```bash
npm ci
npm run build
```

Deploy to the existing admin project. Build command: `npm run build`. Output directory: `build`. Existing staff login is required.

```dotenv
REACT_APP_API_BASE=https://vandhana-shopping-mall-backend.vercel.app
```

Open **Shiwang Offer** in the admin navigation (`/offers/shiwang`). Check the campaign status, end date, quantities and matching variants. Branch administrators see their branch; the super admin sees the configured online branch. The page is an audit view; the fixed campaign rules are defined in the backend. Existing product editing remains available in Products.

The uploaded admin ZIP omitted `public/index.html` and its logo file. Both are supplied so it builds from the ZIP.

## Database commands

**No new migration, table, column or price UPDATE is required.** The live store already lists Shiwang sets at ₹990 in `Women > Kurthi Pant Set` (category 15 at review time). Eligibility is matched by classification rather than a hardcoded category ID. The existing `sales.totals` and `mobile_checkouts.quote` JSON fields store the promotion details; existing `sale_items` store actual charged prices.

In DBeaver, open and run:

```text
vandhana-backend/scripts/verify-shiwang-offer.sql
```

Or, if `DATABASE_URL` is already exported in a terminal with PostgreSQL tools installed, run from the backend folder:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/verify-shiwang-offer.sql
```

This is a read-only query. Its stock query uses branch 3; change that branch filter if your online branch is different. The Node preflight command reads `MOBILE_BRANCH_ID` automatically.

Do not set all product sale prices to ₹799.50. That would incorrectly discount a single set and persist after the offer expires. If the audit returns no eligible rows, correct the existing product brand/gender/category using the admin product editor, then refresh the audit.

No production SQL has been executed for you, and these files have not been deployed to your live site.

## Checks completed

- Both frontend production builds passed; the website TypeScript check passed.
- Backend suite: 81 checks passed, followed by 12/12 offer checks including the additional split-line shipping test (82 distinct backend checks in total).
- Verified quantities 1–12, mixed products/colours/sizes, excluded products and custom items, inventory limits, start/end boundaries, stale quote rejection, authenticated checkout, B2B exclusion, idempotency and payment amount integrity.
- PostgreSQL-compatible integration tests verified saved totals, stock deduction, cart clearing, refund basis and the exact Razorpay amount using local test data and mocked external services.
- DOM checks verified all 43 currently returned Shiwang colour cards retain offer metadata, a three-set cart displays ₹2,589, changing it to two displays ₹1,599, and the three-set COD checkout displays ₹2,619 under the default fee policy.
- No real payment, shipment booking, production order or refund was created.

At default delivery settings: one set totals ₹1,020 prepaid or ₹1,030 COD; two sets total ₹1,599 prepaid or ₹1,629 COD. Your existing environment overrides may change the fees, but not the campaign merchandise total.

## Order accounting and returns

A complete pair is recorded as two units at ₹799.50 each. An unpaired unit is ₹990. When an odd quantity shares a variant, it is stored as separate price lines. This avoids fractional-paise rounding and keeps saved items, payments, invoices, shipping totals and refunds consistent. Shipping SKUs remain distinct for these split lines. Returns follow the existing paid-line refund policy; no new return penalty or pair-discount clawback has been introduced.

## Rollback

Restore the previous deployed backend, website and admin versions from your existing deployment history, or disable the offer with `SHIWANG_OFFER_ENABLED=false` and redeploy the backend. No database rollback is needed because this change does not alter schema or permanently rewrite product prices. Saved orders keep their recorded totals.
