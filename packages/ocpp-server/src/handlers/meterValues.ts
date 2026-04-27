import { prisma } from '@ev-charger/shared';
import { enqueueOcppEvent } from '../outbox';
import type { MeterValuesRequest } from '@ev-charger/shared';
import { evaluateEnergyFlow } from '../fleet/energyFlowPredicate';
import { getPriorEnergy, putPriorEnergy } from '../fleet/priorEnergyState';

// Flag read at call-time so tests and runtime env changes are honored.
function fleetFlagEnabled(): boolean {
  return process.env.FLEET_GATED_SESSIONS_ENABLED === 'true';
}

export function extractLatestEnergyWh(params: MeterValuesRequest): number | null {
  let latestTs = -1;
  let latestWh: number | null = null;

  for (const mv of params.meterValue ?? []) {
    const ts = Date.parse(mv.timestamp);
    for (const sv of mv.sampledValue ?? []) {
      const measurand = sv.measurand ?? 'Energy.Active.Import.Register';
      if (measurand !== 'Energy.Active.Import.Register') continue;

      const raw = Number(sv.value);
      if (!Number.isFinite(raw)) continue;

      const unit = sv.unit ?? 'Wh';
      const wh = unit === 'kWh' ? raw * 1000 : raw;

      if (ts >= latestTs) {
        latestTs = ts;
        latestWh = wh;
      }
    }
  }

  return latestWh;
}

/**
 * Same walk as extractLatestEnergyWh but also returns the frame timestamp.
 * Used by fleet-gated energy-flow observation.
 */
function extractLatestEnergySample(
  params: MeterValuesRequest,
): { wh: number; tsMs: number } | null {
  let latestTs = -1;
  let latestWh: number | null = null;

  for (const mv of params.meterValue ?? []) {
    const ts = Date.parse(mv.timestamp);
    if (!Number.isFinite(ts)) continue;
    for (const sv of mv.sampledValue ?? []) {
      const measurand = sv.measurand ?? 'Energy.Active.Import.Register';
      if (measurand !== 'Energy.Active.Import.Register') continue;

      const raw = Number(sv.value);
      if (!Number.isFinite(raw)) continue;

      const unit = sv.unit ?? 'Wh';
      const wh = unit === 'kWh' ? raw * 1000 : raw;

      if (ts >= latestTs) {
        latestTs = ts;
        latestWh = wh;
      }
    }
  }

  if (latestWh == null || latestTs < 0) return null;
  return { wh: latestWh, tsMs: latestTs };
}

async function resolveActiveSession(
  tx: any,
  chargerId: string,
  connectorId: number,
  transactionId: number | undefined,
) {
  if (transactionId) {
    const byTx = await tx.session.findUnique({ where: { transactionId } });
    if (byTx) return byTx;
  }

  return tx.session.findFirst({
    where: {
      status: 'ACTIVE',
      connector: {
        chargerId,
        connectorId,
      },
    },
    orderBy: { startedAt: 'desc' },
  });
}

export async function handleMeterValues(
  _client: any,
  chargerId: string,
  params: MeterValuesRequest,
): Promise<Record<string, never>> {
  const { connectorId, transactionId, meterValue } = params;
  console.log(`[MeterValues] chargerId=${chargerId} connector=${connectorId} transactionId=${transactionId} readings=${meterValue.length}`);

  const latestWh = extractLatestEnergyWh(params);

  await prisma.$transaction(async (tx: any) => {
    if (latestWh != null) {
      const session = await resolveActiveSession(tx, chargerId, connectorId, transactionId);
      if (session?.status === 'ACTIVE' && session.meterStart != null) {
        const nextMeterStop = Math.max(latestWh, session.meterStop ?? latestWh);
        const kwhDelivered = Math.max(0, (nextMeterStop - session.meterStart) / 1000);

        const shouldWrite = session.meterStop == null || nextMeterStop > session.meterStop;
        if (shouldWrite) {
          await tx.session.update({
            where: { id: session.id },
            data: {
              meterStop: nextMeterStop,
              kwhDelivered,
            },
          });
          console.log(`[MeterValues] live session updated sessionId=${session.id} meterStop=${nextMeterStop}Wh kWh=${kwhDelivered.toFixed(4)}`);
        }

        // ── Fleet energy-flow observation (TASK-0208 Phase 2 PR-c) ─────
        // Flag-gated, observation-only. No enforcement here — PR-d will
        // drive release from this signal.
        //
        // Rules:
        //   - Seed prior state from Session.meterStart + startedAt on the
        //     very first qualifying frame (no prior map entry).
        //   - On flowing frames, always write lastEnergyAt (even after
        //     firstEnergyAt is already set).
        //   - Only set firstEnergyAt on the first flowing transition.
        //   - Any failure is swallowed and logged: observation must never
        //     fail MeterValues. The prisma transaction already committed
        //     the live-session update above, so errors here can't roll
        //     that back — we just skip the fleet writes for this frame.
        if (fleetFlagEnabled() && session.fleetPolicyId) {
          try {
            const sample = extractLatestEnergySample(params);
            if (sample) {
              const prior = getPriorEnergy(session.id) ?? {
                lastWh: session.meterStart,
                lastTsMs: session.startedAt.getTime(),
                touchedAtMs: 0,
              };

              const flow = evaluateEnergyFlow({
                prevWh: prior.lastWh,
                prevTsMs: prior.lastTsMs,
                currWh: sample.wh,
                currTsMs: sample.tsMs,
              });

              if (flow.flowing) {
                const currTs = new Date(sample.tsMs);
                const patch: { firstEnergyAt?: Date; lastEnergyAt: Date } = {
                  lastEnergyAt: currTs,
                };
                if (session.firstEnergyAt == null) {
                  patch.firstEnergyAt = currTs;
                  console.log(
                    `[MeterValues] fleet: first energy flow sessionId=${session.id} policy=${session.fleetPolicyId} at=${currTs.toISOString()} deltaWh=${flow.deltaWh.toFixed(1)} deltaW=${flow.deltaW?.toFixed(0) ?? 'n/a'}`,
                  );
                }
                await tx.session.update({
                  where: { id: session.id },
                  data: patch,
                });
              }

              // Always advance prior state, even when not flowing —
              // otherwise a long tail of sub-threshold frames would keep
              // re-comparing against the stale baseline.
              putPriorEnergy(session.id, { lastWh: sample.wh, lastTsMs: sample.tsMs });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(
              `[MeterValues] fleet observation error (non-fatal): sessionId=${session.id} err=${msg}`,
            );
          }
        }
      } else {
        console.log(`[MeterValues] no ACTIVE session resolved for chargerId=${chargerId} connector=${connectorId} transactionId=${transactionId ?? 'n/a'}`);
      }
    }

    const sampleTs = params.meterValue?.[0]?.timestamp ?? new Date().toISOString();
    await enqueueOcppEvent(tx, {
      chargerId,
      eventType: 'MeterValues',
      payload: params,
      idempotencyKey: `${chargerId}:MeterValues:${transactionId ?? 'na'}:${sampleTs}`,
    });
  });

  return {};
}
