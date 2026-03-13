import { extractLatestEnergyWh } from './meterValues';

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function run() {
  const fromWh = extractLatestEnergyWh({
    connectorId: 1,
    meterValue: [
      {
        timestamp: '2026-03-11T10:00:00Z',
        sampledValue: [{ value: '1000', measurand: 'Energy.Active.Import.Register', unit: 'Wh' }],
      },
      {
        timestamp: '2026-03-11T10:00:05Z',
        sampledValue: [{ value: '1500', measurand: 'Energy.Active.Import.Register', unit: 'Wh' }],
      },
    ],
  } as any);
  assertEqual(fromWh, 1500, 'extracts latest Wh value');

  const fromKwh = extractLatestEnergyWh({
    connectorId: 1,
    meterValue: [
      {
        timestamp: '2026-03-11T10:00:00Z',
        sampledValue: [{ value: '1.25', measurand: 'Energy.Active.Import.Register', unit: 'kWh' }],
      },
    ],
  } as any);
  assertEqual(fromKwh, 1250, 'converts kWh to Wh');

  const ignoresOtherMeasurands = extractLatestEnergyWh({
    connectorId: 1,
    meterValue: [
      {
        timestamp: '2026-03-11T10:00:00Z',
        sampledValue: [{ value: '7000', measurand: 'Power.Active.Import', unit: 'W' }],
      },
    ],
  } as any);
  assertEqual(ignoresOtherMeasurands, null, 'ignores non-energy measurands');

  console.log('[selftest] meterValues extraction checks passed');
}

run();
