import assert from 'assert';
import { computeSessionAmounts, computeVendorFeeUsd } from './sessionBilling';

const percentage = computeSessionAmounts({
  kwhDelivered: 20,
  ratePerKwh: 0.5,
  softwareVendorFeeMode: 'percentage_total',
  softwareVendorFeeValue: 10,
});
assert.equal(percentage.grossAmountCents, 1000);
assert.equal(percentage.vendorFeeCents, 100);
assert.equal(percentage.effectiveAmountCents, 900);

const perKwh = computeSessionAmounts({
  kwhDelivered: 12,
  ratePerKwh: 0.5,
  softwareVendorFeeMode: 'fixed_per_kwh',
  softwareVendorFeeValue: 0.1,
});
assert.equal(perKwh.grossAmountCents, 600);
assert.equal(perKwh.vendorFeeCents, 120);
assert.equal(perKwh.effectiveAmountCents, 480);

const perMinute = computeSessionAmounts({
  kwhDelivered: 10,
  ratePerKwh: 0.5,
  startedAt: '2026-03-15T10:00:00.000Z',
  stoppedAt: '2026-03-15T10:30:00.000Z',
  softwareVendorFeeMode: 'fixed_per_minute',
  softwareVendorFeeValue: 0.05,
});
assert.equal(perMinute.grossAmountCents, 500);
assert.equal(perMinute.vendorFeeCents, 150);
assert.equal(perMinute.effectiveAmountCents, 350);

assert.equal(
  computeVendorFeeUsd({ grossAmountUsd: 5, softwareVendorFeeMode: 'percentage_total', softwareVendorFeeValue: 200 }),
  5,
  'fee is capped to gross amount',
);

console.log('[sessionBilling.selftest] all checks passed');
