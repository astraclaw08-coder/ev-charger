/* eslint-disable no-console */
const assert = require('node:assert/strict');
const { computeIntervalsFromMeterValues } = require('../dist/worker.js');

const sample = [
  {
    timestamp: '2026-03-10T10:58:00Z',
    sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: '10000', unit: 'Wh' }],
  },
  {
    timestamp: '2026-03-10T11:07:00Z',
    sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: '10150', unit: 'Wh' }],
  },
  {
    timestamp: '2026-03-10T11:22:00Z',
    sampledValue: [
      { measurand: 'Energy.Active.Import.Register', value: '10350', unit: 'Wh' },
      { measurand: 'Power.Active.Import', value: '12000', unit: 'W' },
    ],
  },
  {
    timestamp: '2026-03-10T11:55:00Z',
    sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: '10650', unit: 'Wh' }],
  },
];

const intervals = computeIntervalsFromMeterValues(sample);

assert.equal(intervals.length, 3);
assert.equal(intervals[0].intervalStart.toISOString(), '2026-03-10T11:00:00.000Z');
assert.equal(intervals[0].energyKwh, 0.15);
assert.equal(intervals[0].avgPowerKw, 0.6);

assert.equal(intervals[1].intervalStart.toISOString(), '2026-03-10T11:15:00.000Z');
assert.equal(intervals[1].energyKwh, 0.2);
assert.equal(intervals[1].maxPowerKw, 12);

assert.equal(intervals[2].intervalStart.toISOString(), '2026-03-10T11:45:00.000Z');
assert.equal(intervals[2].energyKwh, 0.3);
assert.ok((intervals[2].dataQualityFlag || '').includes('SPARSE_GAP'));

console.log('validate-meter-intervals: PASS');
