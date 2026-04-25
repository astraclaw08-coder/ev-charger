# Orphaned Commits — Split Plan

Context: on 2026-04-23, PR #56 (nominally "Phase 1 fleet scaffold") was found to be contaminated — its branch carried 8 commits, of which only `b8ec11c` (Phase 1 scaffold) was in-scope. The other 7 commits had never reached dev despite MEMORY.md claiming TASK-0096 was COMPLETE on dev.

PR #56 was closed. PR #59 landed Phase 1 cleanly. The 7 orphaned commits still live only on:
- Closed branch `hotfix/task-0208-phase1-fleet-scaffold`
- Feature branch `feat/interval-usage-export`

They must be re-proposed as standalone, reviewable PRs.

## The 7 commits (chronological)

| SHA       | Date   | Title                                                   | Files | Category    |
|-----------|--------|---------------------------------------------------------|-------|-------------|
| `b2cbc1f` | Apr 13 | feat(payments): TASK-0096 Stripe preauth/capture v1     | 28    | Payments    |
| `d788b61` | Apr 13 | fix(payments): add payment_method_types to preauth      | 1     | Payments    |
| `5e42f88` | Apr 13 | docs: add payment system hard rules to CLAUDE.md        | 1     | Payments    |
| `f153f38` | Apr 14 | feat(reservations): redesign holder banner + modal      | 2     | Reservation |
| `b184f7d` | Apr 14 | revert(api): drop fee fields from activeReservation     | 1     | Reservation |
| `0acd541` | Apr 15 | feat(mobile): sync charger detail + reservation polish  | 11    | Reservation |
| `6656fc8` | Apr 15 | fix(mobile): resolve reservation identity mismatch      | 2     | Reservation |

## Proposed split

### PR C: TASK-0096 Stripe preauth/capture v1

**STATUS: ABORTED — DO NOT REPLAY (2026-04-23)**

Cherry-picking `b2cbc1f` onto current dev is **unsafe**. Its migration (`20260413000000_stripe_payment_phase0`) section 6 contains:

```sql
ALTER TABLE "User" DROP COLUMN IF EXISTS "vehicleMake";
ALTER TABLE "User" DROP COLUMN IF EXISTS "vehicleModel";
ALTER TABLE "User" DROP COLUMN IF EXISTS "vehicleName";
ALTER TABLE "User" DROP COLUMN IF EXISTS "vehicleYear";
ALTER TABLE "SessionBillingSnapshot" DROP COLUMN IF EXISTS "receiptSentAt";
```

On the branch where `b2cbc1f` was authored those columns did not yet exist on dev. Between then and now, dev absorbed:
- Vehicle fields on `User` (mobile profile UI + seed data depend on them)
- `receiptSentAt` on `SessionBillingSnapshot` (TASK-0187 email receipts)

Replaying the migration would **destroy live data and break shipped features**.

Additionally, `b2cbc1f` restructures `Payment`:
- `sessionId` UNIQUE → non-unique
- `sessionId` NOT NULL → nullable
- adds `preauthToken`, `authorizedCents`, `deficitCents`, `connectorRefId`

That restructure was designed against a Payment table that no longer resembles current dev. It needs to be re-reasoned from first principles.

**New directive (user, 2026-04-23):** Treat TASK-0096 as a **fresh implementation against current dev**:
- Preserve `User.vehicle*` and `SessionBillingSnapshot.receiptSentAt`
- Re-review any Payment restructure from first principles against current schema and live data expectations
- `d788b61` (`payment_method_types: ['card']`) and `5e42f88` (CLAUDE.md hard rules) can inform the rewrite as design input, but are not cherry-picked

The three orphaned SHAs remain useful as **reference** (design intent, CAS race handling, overflow policy, guest skip rule), not as commits to replay.

---

### PR C (historical, superseded): original replay plan
**Commits to cherry-pick** (in order, then optionally squash):
1. `b2cbc1f` — main implementation (28 files, incl. 2 migrations, schema.prisma +44)
2. `d788b61` — `payment_method_types: ['card']` fix (1 line, discovered in sandbox testing)
3. `5e42f88` — CLAUDE.md payment hard rules (11 lines, documents rules 1-7)

**Rationale for bundling:** these are a single logical feature — v1 Stripe integration with its bug-fix and corresponding documentation. Splitting them creates artificial review surface.

**Risks to verify before opening:**
- Migration ordering: b2cbc1f adds `20260413000000_stripe_payment_phase0` and `20260413010000_add_site_preauth_amount`. Dev now has Phase-1 migration `20260423000000` so ordering is fine, but verify no migration in dev has the same timestamp.
- Schema drift: cherry-pick onto fresh dev. If drift check fails, the remaining gap is real.
- `CustomerSupport.tsx` (portal, 4 lines) — will trip `Theme Token Policy Check` path filter. Acceptable (known dev debt, orthogonal).
- `packages/api/routes/profile.ts` and `sessions.ts` changes may conflict with vehicle/receiptSentAt work already on dev — resolve by unioning, not replacing.

**Acceptance:**
- Real Stripe sandbox E2E: preauth → charge session → capture → receipt visible
- Guest user regression: session creation with no `stripeCustomerId` succeeds (skip rule)
- Overflow test: capture amount > authorized amount → PARTIAL_CAPTURED + deficit persisted
- CAS race: two capture attempts → exactly one succeeds
- StopTransaction succeeds even when capture fails (independence rule)

---

### PR D: Reservation UI redesign (canonical UI per MEMORY.md)
**Current dev gap:** dev's `schema.prisma` does NOT have `feeAmountCents`, `feeStatus`, `feeCancelGraceExpiresAt` on Reservation. Per `b184f7d`'s commit message, those columns exist in prod DB but were never added to dev's schema — another latent drift.

**Sub-split (recommended):**

**PR D.1: Reservation fee-columns schema catch-up (prereq)**
- Port prod columns (`feeAmountCents`, `feeStatus`, `feeCancelGraceExpiresAt`) into dev's schema.prisma
- Add migration SQL (same pattern as PR #58 — port from prod state)
- No code changes, no behavior change
- Tiny, same flavor as PR #58

**PR D.2: Reservation UI redesign**
Cherry-pick (in order):
1. `f153f38` — core redesign (holder card + details modal + API fee select)
2. Skip `b184f7d` entirely — the revert only exists because D.1 hadn't landed yet
3. `0acd541` — sync with main + reservation UI polish (11 files, mostly mobile)
4. `6656fc8` — identity-mismatch bugfix (comparing reservation IDs instead of user IDs across Keycloak/DB)

**Rationale for bundling D.2's three commits:** they represent one evolved UI — f153f38 is the initial cut, 0acd541 adds the dark-pill polish, 6656fc8 fixes the identity bug discovered during testing. Historically these were separate because work progressed over 2 days; there's no value preserving that history in review.

**Risks to verify:**
- `0acd541` touches `profile.tsx` (+603/-... lines) — "sync with main" means the profile screen may collide with current dev profile. Needs careful diff review against current dev.
- `_layout.tsx` tab-bar changes — verify against current dev tab bar state.
- `siteFlow.ts` is new in 0acd541 — check whether current dev has its own siteFlow.ts.
- The canonical UI spec in MEMORY.md ("Reservation UI/UX — DO NOT REDESIGN") was written AS IF these commits had landed. Once PR D.2 lands, that section becomes ground truth rather than aspirational.

---

## Order of operations

```
PR D.1 (schema catch-up for fee fields)  ──┐
                                            ├──► PR D.2 (reservation UI redesign)
PR #59 already landed on dev ───────────────┘
PR C  (TASK-0096 Stripe payments) ─── ABORTED, to be rebuilt fresh (see above)
```

PR D.1 (#60) and PR D.2 (#61): **MERGED to dev**.
PR C: **aborted** — rebuild required, not a replay.

## Explicitly NOT in this plan

- **Portal theme-token debt** (Recharts XAxis/YAxis missing `tick` prop in `Dashboard.tsx`, `SiteDetail.tsx`) — separate dev-branch debt, 1-line-per-axis fix, unrelated to these commits.
- **TASK-0208 Phase 2** — blocked on F5h field validation; do not start until F5h passes.

## Source branches for cherry-pick

```
hotfix/task-0208-phase1-fleet-scaffold   (closed, still accessible by SHA)
feat/interval-usage-export               (also carries these commits)
```

All 7 SHAs are retrievable via `git cherry-pick <sha>` as long as either branch remains in the repo.
