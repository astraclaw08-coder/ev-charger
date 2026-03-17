# TASK-0159 Sensitive Data Hardening Checklist

Date: 2026-03-13
Scope: API + Mobile + DB handling for user profile, payment method references, and transaction history.

## Goals
- Never store raw card PAN or CVV in database, logs, analytics, crash reports, or telemetry.
- Store payment references only (for example, `Card •••• 4242` or provider token IDs).
- Enforce user-scoped access for driver transaction history endpoints.

## Data Classification
- Restricted: auth bearer tokens, payment provider secrets, webhook secrets.
- Confidential: payment method references, user profile address/phone/email, transaction metadata.
- Public/Internal: charger/site metadata without user linkage.

## Required Controls

### API Input Validation
- `PUT /me/profile` must reject payloads that contain PAN-like values (13-19 digits) in payment reference fields.
- `PUT /me/profile` must reject CVV/CVC-like payloads in payment reference fields.
- Name/address/state/zip/email must be validated and normalized server-side.
- Reject invalid date/status query filters for user transaction history endpoints.

### Storage Rules
- Stripe setup/payment data remains in Stripe; local DB stores only references (`paymentProfile`, Stripe IDs, statuses, amounts).
- Do not add columns for card number or CVV in Prisma schema.
- Favorites persistence stores only `userId` + `chargerId` mapping.

### Access Control
- Driver transaction history endpoints must use `requireAuth` and filter by `userId = req.currentUser.id`.
- Operator analytics endpoints remain operator-policy gated (`requireOperator` + policy checks).
- No user endpoint may return another user's sessions, payments, or favorites.

### Logging and Telemetry
- Never log request bodies containing profile/payment payloads verbatim.
- Never log Authorization headers or token values.
- Ensure error logging for payment/profile endpoints does not include raw input payload.

### Secrets and Environment
- Store `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in environment secret manager only.
- Rotate payment/webhook keys on schedule and on incident.
- Restrict production secret read access to least-privilege deployment identities.

### Mobile Client Handling
- Card entry UI must avoid persisting PAN/CVV locally.
- Send only payment setup intent confirmation to Stripe SDK and a safe display reference to API.
- Do not cache sensitive profile/payment payloads in persistent local storage.

## Pre-Production Release Checklist
- [ ] Prisma schema review confirms no PAN/CVV storage fields.
- [ ] `/me/profile` validation rejects PAN/CVV payload tests.
- [ ] `/me/transactions/enriched` returns only authenticated user's data.
- [ ] Favorites endpoints (`/me/favorites`) require auth and enforce user scoping.
- [ ] API build/type-check passes in CI for shared/api/mobile.
- [ ] Runtime smoke test verifies profile update, favorites CRUD, and user transaction history.
- [ ] Logging review confirms no secrets/PAN/CVV in API logs.
- [ ] Secret rotation/ownership documented for prod on-call.

## Incident Response Minimums
- If sensitive data leakage is suspected: revoke keys, rotate secrets, block affected endpoints if needed.
- Preserve audit logs and timeline.
- Notify security owner and complete post-incident remediation before re-enabling affected flow.
