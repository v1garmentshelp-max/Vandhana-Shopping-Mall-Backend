V1Garments backend — order operations release 1.6.
Use Node 24 and your existing database/credentials. Run npm ci, npm run migrate:mobile, npm run migrate:commerce, npm run preflight:mobile, npm run preflight:commerce. Read SETUP_AND_CHANGES.txt for deployment/provider configuration and known operational limits. Never apply tests/support SQL to production.
Verification: 75 backend tests passed; production database/provider flows were not executed.
