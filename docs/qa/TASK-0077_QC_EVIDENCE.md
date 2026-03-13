# TASK-0077 QC Evidence (2026-03-11)

## Scope covered
- Mobile OTP login UI for email/SMS in keycloak mode.
- Resend cooldown timer UX.
- 6-digit verify UX.
- Expiry + invalid code handling.
- Backend OTP issue/verify APIs.
- Secure bearer session creation on OTP verify.
- Rate limiting/abuse guardrails.
- Guest-mode compatibility maintained through `AuthProvider` + `setGuestMode`.

## Build / type checks
1. `npm run build --workspace=packages/shared` => PASS
2. `npm run build --workspace=packages/api` => PASS
3. `./node_modules/.bin/tsc -p packages/mobile/tsconfig.json --noEmit` => PASS

## Runtime verification
Blocker:
- Fastify runtime import in this sandbox fails immediately with `SecItemCopyMatching failed -50` (observed via `node -e "require('./packages/api/dist/server.js')"`).
- Expo runtime launch in this sandbox fails with the same keychain error (observed via `CI=1 npm run dev --workspace=packages/mobile -- --offline`).

Workaround:
- Executed OTP runtime checks directly against compiled service layer (`packages/api/dist/lib/otpAuth.js`) using an in-memory Prisma mock script: `node scripts/tests/task-0077-otp-runtime-check.cjs`.
- This validates issue/verify behavior and persisted data effects without Fastify/Expo boot.
- Host workaround options for final runtime sign-off:
  1. Run API and mobile checks on a non-sandbox host session where macOS keychain APIs are available.
  2. Use simulator/device run from Xcode/Expo locally with same env values (`EXPO_PUBLIC_AUTH_MODE=keycloak`).

Service-level runtime checks run:
1. Email OTP issue => returns `challengeId`, `expiresInSeconds`, `resendAvailableInSeconds`, masked destination.
2. Email OTP verify wrong code => fails `OTP_CODE_INVALID` (401) and decrements attempts.
3. Email OTP verify correct code => returns session token payload and creates user/session records.
4. SMS OTP resend before cooldown => fails `OTP_RESEND_COOLDOWN` (429) with `retryAfterSeconds`.
5. SMS OTP verify after forced expiry => fails `OTP_CODE_EXPIRED` (410).
6. SMS OTP issue + verify success => creates phone-backed user and `otp-sms` session.
7. OTP issue flood => fails `OTP_ISSUE_RATE_LIMIT` (429).

## API/data verification
From runtime script execution (`scripts/tests/task-0077-otp-runtime-check.cjs`):
- Challenge rows persisted and updated (`attemptCount`, `expiresAt`, `consumedAt`).
- User records created for both email and SMS identities (`clerkId` namespaces `otp:email:*` and `otp:sms:*`).
- Session records created with hashed token storage (`tokenHash=sha256(accessToken)`) and TTL (`expiresIn` default 43200s).
- Error code mappings verified for invalid, expired, cooldown, and issue-rate-limit outcomes.

Observed data summary from runtime check:
- `users: 2`
- `challenges: 5`
- `sessions: 2`
- SMS verified session provider: `otp-sms`

## Regression spot-check
- Existing keycloak password login path remains available in mobile sign-in.
- Existing Clerk sign-in form untouched.
- `requireAuth` now accepts secure OTP session tokens before Clerk/Keycloak token fallback; existing Clerk/Keycloak flows remain in place.
- Guest mode behavior preserved: unauthenticated users remain guest; verified OTP creates bearer token and clears guest state.
- Mobile OTP fallback UX now includes:
  - strict email/E.164 phone validation,
  - robust code-specific messaging (invalid/expired/attempts-exceeded/challenge-invalid),
  - explicit "Use Different Email/Phone" recovery path.
