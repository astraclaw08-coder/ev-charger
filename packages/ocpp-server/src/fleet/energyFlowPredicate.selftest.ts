/**
 * energyFlowPredicate — Self-Tests (TASK-0208 Phase 2, PR-c)
 * Run: npx ts-node packages/ocpp-server/src/fleet/energyFlowPredicate.selftest.ts
 */

import {
  evaluateEnergyFlow,
  FLOW_THRESHOLD_W,
  FLOW_SHORT_WINDOW_WH,
  FLOW_SHORT_WINDOW_MS,
  FLOW_FALLBACK_WH,
} from './energyFlowPredicate';

let passed = 0;
let failed = 0;
function assert(c: boolean, name: string) {
  if (c) { passed++; console.log(`  ✅ ${name}`); }
  else   { failed++; console.error(`  ❌ ${name}`); }
}

async function main() {

// ─── Rule A: instantaneous power ≥ 50 W ───────────────────────────────
console.log('\n--- Rule A: instantaneous power threshold ---');
{
  // 100 Wh over 60s = 6 kW → flowing
  const r = evaluateEnergyFlow({ prevWh: 1000, prevTsMs: 0, currWh: 1100, currTsMs: 60_000 });
  assert(r.flowing === true, 'strong power flow (6 kW) flowing=true');
  assert(r.deltaWh === 100, 'deltaWh=100');
  assert(r.deltaW !== null && Math.round(r.deltaW!) === 6000, 'deltaW≈6000');
}
{
  // 5 Wh over 600s (10 min) = 30 W — below 50 W threshold, above 0 but below fallback Wh
  const r = evaluateEnergyFlow({ prevWh: 1000, prevTsMs: 0, currWh: 1005, currTsMs: 600_000 });
  assert(r.flowing === false, '30 W trickle not flowing');
  assert(r.deltaW !== null && Math.round(r.deltaW!) === 30, 'deltaW≈30');
}
{
  // Exactly 50 W boundary: 50 Wh over 3600s = 50 W
  const r = evaluateEnergyFlow({ prevWh: 0, prevTsMs: 0, currWh: 50, currTsMs: 3_600_000 });
  assert(r.flowing === true, 'exact 50 W threshold flowing=true (≥ boundary)');
}

// ─── Rule B: ≥ 10 Wh over ≤ 60 s short window ─────────────────────────
console.log('\n--- Rule B: short-window small-delta ---');
{
  // 10 Wh over 30s: below 50 W (1200 W actually — wait: 10 Wh / (30/3600 h) = 1200 W).
  // Let's engineer a case that triggers B but not A. Need: deltaWh ≥ 10,
  // deltaMs ≤ 60000, deltaW < 50. deltaW < 50 needs deltaWh/deltaHours < 50,
  // i.e. deltaWh < 50 * deltaMs/3600000. For deltaMs=60000 that's <0.83 Wh.
  // So rule B can't fire without rule A also firing unless we make deltaWh
  // smaller — but B requires ≥10 Wh. Rule B only helps when the power calc
  // would be > 50 W (i.e. rule A already fires). Verify B doesn't regress
  // rule A: 10 Wh over 60s = 600 W → A fires anyway.
  const r = evaluateEnergyFlow({ prevWh: 0, prevTsMs: 0, currWh: 10, currTsMs: 60_000 });
  assert(r.flowing === true, '10 Wh over 60s flowing=true (rule A&B both qualify)');
}
{
  // 10 Wh over 30s — rule A at 1200 W fires
  const r = evaluateEnergyFlow({ prevWh: 0, prevTsMs: 0, currWh: 10, currTsMs: 30_000 });
  assert(r.flowing === true, '10 Wh over 30s flowing=true');
}

// ─── Rule C: ≥ 50 Wh fallback regardless of interval ──────────────────
console.log('\n--- Rule C: fallback large-delta ---');
{
  // 50 Wh over 5 hours — instantaneous is 10 W (below A), interval too long for B,
  // but fallback C triggers at ≥ 50 Wh.
  const r = evaluateEnergyFlow({ prevWh: 0, prevTsMs: 0, currWh: 50, currTsMs: 5 * 3_600_000 });
  assert(r.flowing === true, '50 Wh over 5h flowing=true via fallback');
  assert(r.deltaW !== null && Math.round(r.deltaW!) === 10, 'deltaW≈10 (sub-threshold)');
}
{
  // 49 Wh over 5 hours — just below fallback, sub-threshold power
  const r = evaluateEnergyFlow({ prevWh: 0, prevTsMs: 0, currWh: 49, currTsMs: 5 * 3_600_000 });
  assert(r.flowing === false, '49 Wh over 5h not flowing');
}

// ─── Negative / zero deltas ───────────────────────────────────────────
console.log('\n--- negative and zero deltas ---');
{
  const r = evaluateEnergyFlow({ prevWh: 1000, prevTsMs: 0, currWh: 999, currTsMs: 60_000 });
  assert(r.flowing === false, 'meter regression not flowing');
  assert(r.deltaWh === -1, 'deltaWh=-1 still reported');
}
{
  const r = evaluateEnergyFlow({ prevWh: 1000, prevTsMs: 0, currWh: 1000, currTsMs: 60_000 });
  assert(r.flowing === false, 'zero delta not flowing');
}

// ─── Zero / negative time delta ───────────────────────────────────────
console.log('\n--- zero and negative time delta ---');
{
  // Same timestamp, positive Wh delta ≥ fallback → still flowing via C
  const r = evaluateEnergyFlow({ prevWh: 0, prevTsMs: 1000, currWh: 100, currTsMs: 1000 });
  assert(r.flowing === true, 'same-timestamp but ≥50 Wh fallback → flowing');
  assert(r.deltaW === null, 'deltaW=null when deltaMs=0');
}
{
  // Clock went backwards, small delta — not flowing
  const r = evaluateEnergyFlow({ prevWh: 0, prevTsMs: 1000, currWh: 5, currTsMs: 500 });
  assert(r.flowing === false, 'clock-regression small delta not flowing');
  assert(r.deltaW === null, 'deltaW=null when deltaMs<0');
}

// ─── Threshold constants exported ─────────────────────────────────────
console.log('\n--- exported thresholds match contract ---');
{
  assert(FLOW_THRESHOLD_W === 50, 'FLOW_THRESHOLD_W=50');
  assert(FLOW_SHORT_WINDOW_WH === 10, 'FLOW_SHORT_WINDOW_WH=10');
  assert(FLOW_SHORT_WINDOW_MS === 60_000, 'FLOW_SHORT_WINDOW_MS=60000');
  assert(FLOW_FALLBACK_WH === 50, 'FLOW_FALLBACK_WH=50');
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);

}

main().catch((err) => {
  console.error('Selftest crashed:', err);
  process.exit(1);
});
