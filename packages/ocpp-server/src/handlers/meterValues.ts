import { prisma } from '@ev-charger/shared';
import type { MeterValuesRequest } from '@ev-charger/shared';

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

  return {};
}
