/**
 * Type aliases for Prisma schema enums.
 * Mirrors packages/shared/prisma/schema.prisma enum definitions so that
 * consumers (api, ocpp-server) can import these types without depending on
 * the generated @prisma/client output, which requires `prisma generate` to
 * have been run first.
 *
 * When the Prisma client IS generated these are structurally compatible with
 * the generated types because Prisma 5 uses string literal unions internally.
 */

export type ChargerStatus = 'OFFLINE' | 'ONLINE' | 'FAULTED';

export type ConnectorStatus =
  | 'AVAILABLE'
  | 'PREPARING'
  | 'CHARGING'
  | 'SUSPENDED_EVSE'
  | 'SUSPENDED_EV'
  | 'FINISHING'
  | 'RESERVED'
  | 'UNAVAILABLE'
  | 'FAULTED';

export type SessionStatus = 'ACTIVE' | 'COMPLETED' | 'FAILED';

export type PaymentStatus = 'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'REFUNDED';

export type OcppDirection = 'INBOUND' | 'OUTBOUND';

export type UptimeEventType = 'ONLINE' | 'OFFLINE' | 'FAULTED' | 'RECOVERED' | 'SCHEDULED_MAINTENANCE' | 'UTILITY_INTERRUPTION' | 'VEHICLE_FAULT' | 'VANDALISM' | 'FORCE_MAJEURE';

export type SmartChargingScope = 'CHARGER' | 'GROUP' | 'SITE';
