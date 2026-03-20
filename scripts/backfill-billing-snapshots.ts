/**
 * Backfill SessionBillingSnapshot for all completed sessions that don't have one.
 *
 * Usage:
 *   npx ts-node scripts/backfill-billing-snapshots.ts           # dry run (safe)
 *   npx ts-node scripts/backfill-billing-snapshots.ts --write   # apply
 */
import { backfillBillingSnapshots } from '../packages/shared/src/billing/snapshotBilling';

const dryRun = !process.argv.includes('--write');
const force = process.argv.includes('--force');

(async () => {
  const result = await backfillBillingSnapshots({ dryRun, force });
  console.log('\nResult:', result);
  process.exit(result.errors > 0 ? 1 : 0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
