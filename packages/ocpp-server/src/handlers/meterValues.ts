import { prisma } from '@ev-charger/shared';
import { enqueueOcppEvent } from '../outbox';
import type { MeterValuesRequest } from '@ev-charger/shared';

function extractLatestEnergyWh(params: MeterValuesRequest): number | null {
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

export async function handleMeterValues(
  _client: any,
  chargerId: string,
  params: MeterValuesRequest,
): Promise<Record<string, never>> {
  const { connectorId, transactionId, meterValue } = params;
  console.log(`[MeterValues] chargerId=${chargerId} connector=${connectorId} transactionId=${transactionId} readings=${meterValue.length}`);

  // Update ACTIVE session with live meter/kWh so mobile app can show real-time energy.
  const latestWh = extractLatestEnergyWh(params);

  await prisma.$transaction(async (tx) => {
    if (transactionId && latestWh != null) {
      const session = await tx.session.findUnique({ where: { transactionId } });
      if (session?.status === 'ACTIVE' && session.meterStart != null) {
        const kwhDelivered = Math.max(0, (latestWh - session.meterStart) / 1000);
        await tx.session.update({
          where: { id: session.id },
          data: {
            meterStop: latestWh,
            kwhDelivered,
          },
        });
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
