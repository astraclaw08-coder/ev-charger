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

const flatDetailed = computeSessionAmounts({
  kwhDelivered: 10,
  ratePerKwh: 0.4,
  startedAt: '2026-03-15T10:00:00.000Z',
  stoppedAt: '2026-03-15T10:20:00.000Z',
  idleStartedAt: '2026-03-15T10:20:00.000Z',
  idleStoppedAt: '2026-03-15T10:40:00.000Z',
  idleFeePerMinUsd: 0.1,
  gracePeriodMin: 10,
  activationFeeUsd: 1.5,
});
assert.equal(flatDetailed.billingBreakdown.energy.totalUsd, 4);
assert.equal(flatDetailed.billingBreakdown.idle.totalUsd, 1);
assert.equal(flatDetailed.billingBreakdown.activation.totalUsd, 1.5);
assert.equal(flatDetailed.grossAmountCents, 650);

const touDetailed = computeSessionAmounts({
  kwhDelivered: 12,
  ratePerKwh: 0.2,
  pricingMode: 'tou',
  pricePerKwhUsd: 0.2,
  idleFeePerMinUsd: 0.02,
  gracePeriodMin: 10,
  activationFeeUsd: 1,
  startedAt: '2026-03-16T09:00:00.000Z',
  stoppedAt: '2026-03-16T11:00:00.000Z',
  idleStartedAt: '2026-03-16T10:20:00.000Z',
  idleStoppedAt: '2026-03-16T11:00:00.000Z',
  siteTimeZone: 'UTC',
  touWindows: [
    { day: 1, start: '09:00', end: '10:00', pricePerKwhUsd: 0.2, idleFeePerMinUsd: 0.02 },
    { day: 1, start: '10:00', end: '11:00', pricePerKwhUsd: 0.5, idleFeePerMinUsd: 0.08 },
  ],
});
assert.equal(touDetailed.billingBreakdown.energy.segments.length, 2);
assert.equal(touDetailed.billingBreakdown.energy.segments[0].kwh, 6);
assert.equal(touDetailed.billingBreakdown.energy.segments[1].kwh, 6);
assert.equal(touDetailed.billingBreakdown.energy.totalUsd, 4.2);
assert.equal(touDetailed.billingBreakdown.idle.totalUsd, 2.4);
assert.equal(touDetailed.grossAmountCents, 760);

// Overnight session spanning midnight: windows stored as two adjacent same-rate split-at-midnight windows
// Mon 22:00 PT (05:00 UTC Mar 17) → Tue 01:00 PT (08:00 UTC Mar 17) — entirely within the $0.50 window
const overnightTou = computeSessionAmounts({
  kwhDelivered: 10,
  pricingMode: 'tou',
  pricePerKwhUsd: 0.3,
  idleFeePerMinUsd: 0.02,
  startedAt: '2026-03-17T05:00:00.000Z', // Mon 22:00 LA
  stoppedAt: '2026-03-17T08:00:00.000Z', // Tue 01:00 LA
  siteTimeZone: 'America/Los_Angeles',
  touWindows: [
    { day: 1, start: '21:00', end: '00:00', pricePerKwhUsd: 0.5, idleFeePerMinUsd: 0.07 }, // Mon 21:00–midnight
    { day: 2, start: '00:00', end: '07:00', pricePerKwhUsd: 0.5, idleFeePerMinUsd: 0.07 }, // Tue midnight–07:00
  ],
});
// Should merge into 1 segment (both halves same rate)
assert.equal(overnightTou.billingBreakdown.energy.segments.length, 1, 'overnight same-rate windows should merge to 1 segment');
assert.equal(overnightTou.billingBreakdown.energy.segments[0].pricePerKwhUsd, 0.5);
assert.equal(overnightTou.billingBreakdown.energy.totalUsd, 5);

const adjacentSameRate = computeSessionAmounts({
  kwhDelivered: 8,
  pricingMode: 'tou',
  pricePerKwhUsd: 0.2,
  idleFeePerMinUsd: 0.01,
  startedAt: '2026-03-16T09:00:00.000Z',
  stoppedAt: '2026-03-16T11:00:00.000Z',
  siteTimeZone: 'UTC',
  touWindows: [
    { day: 1, start: '09:00', end: '10:00', pricePerKwhUsd: 0.4, idleFeePerMinUsd: 0.02 },
    { day: 1, start: '10:00', end: '11:00', pricePerKwhUsd: 0.4, idleFeePerMinUsd: 0.02 },
  ],
});
assert.equal(adjacentSameRate.billingBreakdown.energy.segments.length, 1);
assert.equal(adjacentSameRate.billingBreakdown.energy.segments[0].pricePerKwhUsd, 0.4);

// Regression: 23:59 end-of-day window must not leave a 1-min gap at 11:59 PM
const gap2359 = computeSessionAmounts({
  kwhDelivered: 10,
  pricingMode: 'tou',
  pricePerKwhUsd: 0.4,
  idleFeePerMinUsd: 0.08,
  startedAt: '2026-03-20T04:09:00.000Z',  // 9:09 PM Thu LA
  stoppedAt: '2026-03-20T11:40:00.000Z',  // 4:40 AM Fri LA
  siteTimeZone: 'America/Los_Angeles',
  touWindows: [
    { day: 4, start: '21:00', end: '23:59', pricePerKwhUsd: 0.15, idleFeePerMinUsd: 0.02 },
    { day: 5, start: '00:00', end: '03:00', pricePerKwhUsd: 0.15, idleFeePerMinUsd: 0.02 },
    { day: 5, start: '03:00', end: '06:00', pricePerKwhUsd: 0.3,  idleFeePerMinUsd: 0.05 },
  ],
});
// Should be exactly 2 segments (0.15 and 0.30), no flat $0.40 spike
assert.equal(gap2359.billingBreakdown.energy.segments.length, 2, '23:59 gap must produce exactly 2 segments');
assert.equal(gap2359.billingBreakdown.energy.segments[0].pricePerKwhUsd, 0.15, 'first segment must be 0.15');
assert.equal(gap2359.billingBreakdown.energy.segments[1].pricePerKwhUsd, 0.3,  'second segment must be 0.30');

assert.equal(
  computeVendorFeeUsd({ grossAmountUsd: 5, softwareVendorFeeMode: 'percentage_total', softwareVendorFeeValue: 200 }),
  5,
  'fee is capped to gross amount',
);

console.log('[sessionBilling.selftest] all checks passed');
