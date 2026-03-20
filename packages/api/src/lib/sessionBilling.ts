/**
 * Billing engine re-exported from @ev-charger/shared.
 * The canonical implementation lives in packages/shared/src/billing/sessionBilling.ts
 * so OCPP server and snapshot capture can use it without cross-package imports.
 */
export {
  computeSessionAmounts,
  computeDeliveredKwh,
  computeVendorFeeUsd,
} from '@ev-charger/shared';

export type {
  AmountState,
  SoftwareVendorFeeMode,
  BillingSegment,
  BillingBreakdown,
} from '@ev-charger/shared';
