import { prisma } from '@ev-charger/shared';
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

  // Persist to OcppLog for audit and analytics
  await prisma.ocppLog.create({
    data: {
      chargerId,
      direction: 'INBOUND',
      messageType: 2,
      messageId: `mv-${Date.now()}`,
      action: 'MeterValues',
      payload: params as object,
    },
  });

  // Update ACTIVE session with live meter/kWh so mobile app can show real-time energy.
  const latestWh = extractLatestEnergyWh(params);
  if (transactionId && latestWh != null) {
    const session = await prisma.session.findUnique({ where: { transactionId } });
    if (session?.status === 'ACTIVE' && session.meterStart != null) {
      const kwhDelivered = Math.max(0, (latestWh - session.meterStart) / 1000);
      await prisma.session.update({
        where: { id: session.id },
        data: {
          meterStop: latestWh,
          kwhDelivered,
        },
      });
    }
  }

  return {};
}
