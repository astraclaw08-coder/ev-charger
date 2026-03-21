import { prisma } from '@ev-charger/shared';
import { enqueueOcppEvent } from '../outbox';
import type { MeterValuesRequest } from '@ev-charger/shared';

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
