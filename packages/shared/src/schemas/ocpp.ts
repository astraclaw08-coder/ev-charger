import { z } from 'zod';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const RegistrationStatusSchema = z.enum(['Accepted', 'Pending', 'Rejected']);

export const AuthorizationStatusSchema = z.enum([
  'Accepted', 'Blocked', 'Expired', 'Invalid', 'ConcurrentTx',
]);

export const ChargePointStatusSchema = z.enum([
  'Available', 'Preparing', 'Charging', 'SuspendedEVSE', 'SuspendedEV',
  'Finishing', 'Reserved', 'Unavailable', 'Faulted',
]);

export const ChargePointErrorCodeSchema = z.enum([
  'ConnectorLockFailure', 'EVCommunicationError', 'GroundFailure', 'HighTemperature',
  'InternalError', 'LocalListConflict', 'NoError', 'OtherError', 'OverCurrentFailure',
  'PowerMeterFailure', 'PowerSwitchFailure', 'ReaderFailure', 'ResetFailure',
  'UnderVoltage', 'OverVoltage', 'WeakSignal',
]);

export const RemoteStartStopStatusSchema = z.enum(['Accepted', 'Rejected']);

export const AvailabilityTypeSchema = z.enum(['Inoperative', 'Operative']);

export const AvailabilityStatusSchema = z.enum(['Accepted', 'Rejected', 'Scheduled']);

export const ResetTypeSchema = z.enum(['Hard', 'Soft']);

export const ResetStatusSchema = z.enum(['Accepted', 'Rejected']);

export const ReasonSchema = z.enum([
  'DeAuthorized', 'EmergencyStop', 'EVDisconnected', 'HardReset', 'Local',
  'Other', 'PowerLoss', 'Reboot', 'Remote', 'SoftReset', 'UnlockCommand',
]);

export const ReadingContextSchema = z.enum([
  'Interruption.Begin', 'Interruption.End', 'Other', 'Sample.Clock',
  'Sample.Periodic', 'Transaction.Begin', 'Transaction.End', 'Trigger',
]);

export const MeasurandSchema = z.enum([
  'Energy.Active.Export.Register', 'Energy.Active.Import.Register',
  'Energy.Reactive.Export.Register', 'Energy.Reactive.Import.Register',
  'Energy.Active.Export.Interval', 'Energy.Active.Import.Interval',
  'Energy.Reactive.Export.Interval', 'Energy.Reactive.Import.Interval',
  'Power.Active.Export', 'Power.Active.Import', 'Power.Offered',
  'Power.Reactive.Export', 'Power.Reactive.Import', 'Power.Factor',
  'Current.Import', 'Current.Export', 'Current.Offered',
  'Voltage', 'Frequency', 'Temperature', 'SoC', 'RPM',
]);

export const UnitOfMeasureSchema = z.enum([
  'Wh', 'kWh', 'varh', 'kvarh', 'W', 'kW', 'VA', 'kVA',
  'var', 'kvar', 'A', 'V', 'K', 'Celsius', 'Fahrenheit', 'Percent',
]);

// ─── Shared sub-schemas ───────────────────────────────────────────────────────

export const IdTagInfoSchema = z.object({
  status: AuthorizationStatusSchema,
  expiryDate: z.string().datetime().optional(),
  parentIdTag: z.string().max(20).optional(),
});

export const SampledValueSchema = z.object({
  value: z.string(),
  context: ReadingContextSchema.optional(),
  format: z.enum(['Raw', 'SignedData']).optional(),
  measurand: MeasurandSchema.optional(),
  phase: z.enum(['L1','L2','L3','N','L1-N','L2-N','L3-N','L1-L2','L2-L3','L3-L1']).optional(),
  location: z.string().optional(),
  unit: UnitOfMeasureSchema.optional(),
});

export const MeterValueSchema = z.object({
  timestamp: z.string().datetime(),
  sampledValue: z.array(SampledValueSchema),
});

// ─── BootNotification ─────────────────────────────────────────────────────────

export const BootNotificationRequestSchema = z.object({
  chargePointVendor: z.string().max(20),
  chargePointModel: z.string().max(20),
  chargePointSerialNumber: z.string().max(25).optional(),
  chargeBoxSerialNumber: z.string().max(25).optional(),
  firmwareVersion: z.string().max(50).optional(),
  iccid: z.string().max(20).optional(),
  imsi: z.string().max(20).optional(),
  meterSerialNumber: z.string().max(25).optional(),
  meterType: z.string().max(25).optional(),
});

export const BootNotificationResponseSchema = z.object({
  currentTime: z.string().datetime(),
  interval: z.number().int().nonnegative(),
  status: RegistrationStatusSchema,
});

// ─── Heartbeat ────────────────────────────────────────────────────────────────

export const HeartbeatRequestSchema = z.object({}).strict();

export const HeartbeatResponseSchema = z.object({
  currentTime: z.string().datetime(),
});

// ─── StatusNotification ───────────────────────────────────────────────────────

export const StatusNotificationRequestSchema = z.object({
  connectorId: z.number().int().nonnegative(),
  errorCode: ChargePointErrorCodeSchema,
  info: z.string().max(50).optional(),
  status: ChargePointStatusSchema,
  timestamp: z.string().datetime().optional(),
  vendorId: z.string().max(255).optional(),
  vendorErrorCode: z.string().max(50).optional(),
});

export const StatusNotificationResponseSchema = z.object({}).strict();

// ─── Authorize ────────────────────────────────────────────────────────────────

export const AuthorizeRequestSchema = z.object({
  idTag: z.string().max(20),
});

export const AuthorizeResponseSchema = z.object({
  idTagInfo: IdTagInfoSchema,
});

// ─── StartTransaction ─────────────────────────────────────────────────────────

export const StartTransactionRequestSchema = z.object({
  connectorId: z.number().int().positive(),
  idTag: z.string().max(20),
  meterStart: z.number().int().nonnegative(),
  reservationId: z.number().int().optional(),
  timestamp: z.string().datetime(),
});

export const StartTransactionResponseSchema = z.object({
  idTagInfo: IdTagInfoSchema,
  transactionId: z.number().int().positive(),
});

// ─── StopTransaction ──────────────────────────────────────────────────────────

export const StopTransactionRequestSchema = z.object({
  idTag: z.string().max(20).optional(),
  meterStop: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  transactionId: z.number().int().positive(),
  reason: ReasonSchema.optional(),
  transactionData: z.array(MeterValueSchema).optional(),
});

export const StopTransactionResponseSchema = z.object({
  idTagInfo: IdTagInfoSchema.optional(),
});

// ─── MeterValues ──────────────────────────────────────────────────────────────

export const MeterValuesRequestSchema = z.object({
  connectorId: z.number().int().nonnegative(),
  transactionId: z.number().int().optional(),
  meterValue: z.array(MeterValueSchema),
});

export const MeterValuesResponseSchema = z.object({}).strict();

// ─── RemoteStartTransaction ───────────────────────────────────────────────────

export const RemoteStartTransactionRequestSchema = z.object({
  connectorId: z.number().int().positive().optional(),
  idTag: z.string().max(20),
});

export const RemoteStartTransactionResponseSchema = z.object({
  status: RemoteStartStopStatusSchema,
});

// ─── RemoteStopTransaction ────────────────────────────────────────────────────

export const RemoteStopTransactionRequestSchema = z.object({
  transactionId: z.number().int().positive(),
});

export const RemoteStopTransactionResponseSchema = z.object({
  status: RemoteStartStopStatusSchema,
});

// ─── ChangeAvailability ───────────────────────────────────────────────────────

export const ChangeAvailabilityRequestSchema = z.object({
  connectorId: z.number().int().nonnegative(),
  type: AvailabilityTypeSchema,
});

export const ChangeAvailabilityResponseSchema = z.object({
  status: AvailabilityStatusSchema,
});

// ─── Reset ────────────────────────────────────────────────────────────────────

export const ResetRequestSchema = z.object({
  type: ResetTypeSchema,
});

export const ResetResponseSchema = z.object({
  status: ResetStatusSchema,
});

// ─── Inferred types from schemas ──────────────────────────────────────────────

export type BootNotificationRequestZ = z.infer<typeof BootNotificationRequestSchema>;
export type BootNotificationResponseZ = z.infer<typeof BootNotificationResponseSchema>;
export type HeartbeatRequestZ = z.infer<typeof HeartbeatRequestSchema>;
export type HeartbeatResponseZ = z.infer<typeof HeartbeatResponseSchema>;
export type StatusNotificationRequestZ = z.infer<typeof StatusNotificationRequestSchema>;
export type AuthorizeRequestZ = z.infer<typeof AuthorizeRequestSchema>;
export type AuthorizeResponseZ = z.infer<typeof AuthorizeResponseSchema>;
export type StartTransactionRequestZ = z.infer<typeof StartTransactionRequestSchema>;
export type StartTransactionResponseZ = z.infer<typeof StartTransactionResponseSchema>;
export type StopTransactionRequestZ = z.infer<typeof StopTransactionRequestSchema>;
export type MeterValuesRequestZ = z.infer<typeof MeterValuesRequestSchema>;
export type RemoteStartTransactionRequestZ = z.infer<typeof RemoteStartTransactionRequestSchema>;
export type RemoteStopTransactionRequestZ = z.infer<typeof RemoteStopTransactionRequestSchema>;
export type ChangeAvailabilityRequestZ = z.infer<typeof ChangeAvailabilityRequestSchema>;
export type ResetRequestZ = z.infer<typeof ResetRequestSchema>;
