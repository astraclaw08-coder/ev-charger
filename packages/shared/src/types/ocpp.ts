// OCPP 1.6J TypeScript types for all MVP messages

// ─── Enums ────────────────────────────────────────────────────────────────────

export type RegistrationStatus = 'Accepted' | 'Pending' | 'Rejected';
export type AuthorizationStatus = 'Accepted' | 'Blocked' | 'Expired' | 'Invalid' | 'ConcurrentTx';
export type ChargePointStatus =
  | 'Available'
  | 'Preparing'
  | 'Charging'
  | 'SuspendedEVSE'
  | 'SuspendedEV'
  | 'Finishing'
  | 'Reserved'
  | 'Unavailable'
  | 'Faulted';

export type ChargePointErrorCode =
  | 'ConnectorLockFailure'
  | 'EVCommunicationError'
  | 'GroundFailure'
  | 'HighTemperature'
  | 'InternalError'
  | 'LocalListConflict'
  | 'NoError'
  | 'OtherError'
  | 'OverCurrentFailure'
  | 'PowerMeterFailure'
  | 'PowerSwitchFailure'
  | 'ReaderFailure'
  | 'ResetFailure'
  | 'UnderVoltage'
  | 'OverVoltage'
  | 'WeakSignal';

export type RemoteStartStopStatus = 'Accepted' | 'Rejected';
export type AvailabilityType = 'Inoperative' | 'Operative';
export type AvailabilityStatus = 'Accepted' | 'Rejected' | 'Scheduled';
export type ResetType = 'Hard' | 'Soft';
export type ResetStatus = 'Accepted' | 'Rejected';
export type Reason =
  | 'DeAuthorized'
  | 'EmergencyStop'
  | 'EVDisconnected'
  | 'HardReset'
  | 'Local'
  | 'Other'
  | 'PowerLoss'
  | 'Reboot'
  | 'Remote'
  | 'SoftReset'
  | 'UnlockCommand';

export type ReadingContext =
  | 'Interruption.Begin'
  | 'Interruption.End'
  | 'Other'
  | 'Sample.Clock'
  | 'Sample.Periodic'
  | 'Transaction.Begin'
  | 'Transaction.End'
  | 'Trigger';

export type ValueFormat = 'Raw' | 'SignedData';
export type Measurand =
  | 'Energy.Active.Export.Register'
  | 'Energy.Active.Import.Register'
  | 'Energy.Reactive.Export.Register'
  | 'Energy.Reactive.Import.Register'
  | 'Energy.Active.Export.Interval'
  | 'Energy.Active.Import.Interval'
  | 'Energy.Reactive.Export.Interval'
  | 'Energy.Reactive.Import.Interval'
  | 'Power.Active.Export'
  | 'Power.Active.Import'
  | 'Power.Offered'
  | 'Power.Reactive.Export'
  | 'Power.Reactive.Import'
  | 'Power.Factor'
  | 'Current.Import'
  | 'Current.Export'
  | 'Current.Offered'
  | 'Voltage'
  | 'Frequency'
  | 'Temperature'
  | 'SoC'
  | 'RPM';

export type Phase =
  | 'L1'
  | 'L2'
  | 'L3'
  | 'N'
  | 'L1-N'
  | 'L2-N'
  | 'L3-N'
  | 'L1-L2'
  | 'L2-L3'
  | 'L3-L1';

export type UnitOfMeasure = 'Wh' | 'kWh' | 'varh' | 'kvarh' | 'W' | 'kW' | 'VA' | 'kVA' | 'var' | 'kvar' | 'A' | 'V' | 'K' | 'Celsius' | 'Fahrenheit' | 'Percent';

// ─── Shared sub-types ─────────────────────────────────────────────────────────

export interface IdTagInfo {
  status: AuthorizationStatus;
  expiryDate?: string;    // ISO 8601
  parentIdTag?: string;
}

export interface SampledValue {
  value: string;
  context?: ReadingContext;
  format?: ValueFormat;
  measurand?: Measurand;
  phase?: Phase;
  location?: string;
  unit?: UnitOfMeasure;
}

export interface MeterValue {
  timestamp: string;      // ISO 8601
  sampledValue: SampledValue[];
}

// ─── BootNotification ─────────────────────────────────────────────────────────

export interface BootNotificationRequest {
  chargePointVendor: string;
  chargePointModel: string;
  chargePointSerialNumber?: string;
  chargeBoxSerialNumber?: string;
  firmwareVersion?: string;
  iccid?: string;
  imsi?: string;
  meterSerialNumber?: string;
  meterType?: string;
}

export interface BootNotificationResponse {
  currentTime: string;    // ISO 8601
  interval: number;       // heartbeat interval in seconds
  status: RegistrationStatus;
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

export type HeartbeatRequest = Record<string, never>;

export interface HeartbeatResponse {
  currentTime: string;    // ISO 8601
}

// ─── StatusNotification ───────────────────────────────────────────────────────

export interface StatusNotificationRequest {
  connectorId: number;
  errorCode: ChargePointErrorCode;
  info?: string;
  status: ChargePointStatus;
  timestamp?: string;
  vendorId?: string;
  vendorErrorCode?: string;
}

export type StatusNotificationResponse = Record<string, never>;

// ─── Authorize ────────────────────────────────────────────────────────────────

export interface AuthorizeRequest {
  idTag: string;
}

export interface AuthorizeResponse {
  idTagInfo: IdTagInfo;
}

// ─── StartTransaction ─────────────────────────────────────────────────────────

export interface StartTransactionRequest {
  connectorId: number;
  idTag: string;
  meterStart: number;     // Wh
  reservationId?: number;
  timestamp: string;      // ISO 8601
}

export interface StartTransactionResponse {
  idTagInfo: IdTagInfo;
  transactionId: number;
}

// ─── StopTransaction ──────────────────────────────────────────────────────────

export interface StopTransactionRequest {
  idTag?: string;
  meterStop: number;      // Wh
  timestamp: string;      // ISO 8601
  transactionId: number;
  reason?: Reason;
  transactionData?: MeterValue[];
}

export interface StopTransactionResponse {
  idTagInfo?: IdTagInfo;
}

// ─── MeterValues ──────────────────────────────────────────────────────────────

export interface MeterValuesRequest {
  connectorId: number;
  transactionId?: number;
  meterValue: MeterValue[];
}

export type MeterValuesResponse = Record<string, never>;

// ─── RemoteStartTransaction (Server → Charger) ────────────────────────────────

export interface RemoteStartTransactionRequest {
  connectorId?: number;
  idTag: string;
}

export interface RemoteStartTransactionResponse {
  status: RemoteStartStopStatus;
}

// ─── RemoteStopTransaction (Server → Charger) ─────────────────────────────────

export interface RemoteStopTransactionRequest {
  transactionId: number;
}

export interface RemoteStopTransactionResponse {
  status: RemoteStartStopStatus;
}

// ─── ChangeAvailability (Server → Charger) ────────────────────────────────────

export interface ChangeAvailabilityRequest {
  connectorId: number;
  type: AvailabilityType;
}

export interface ChangeAvailabilityResponse {
  status: AvailabilityStatus;
}

// ─── Reset (Server → Charger) ─────────────────────────────────────────────────

export interface ResetRequest {
  type: ResetType;
}

export interface ResetResponse {
  status: ResetStatus;
}

// ─── SetChargingProfile (Server → Charger) ───────────────────────────────────

export type ChargingProfilePurposeType = 'ChargePointMaxProfile' | 'TxDefaultProfile' | 'TxProfile';
export type ChargingProfileKindType = 'Absolute' | 'Recurring' | 'Relative';
export type ChargingRateUnitType = 'A' | 'W';
export type ChargingProfileStatus = 'Accepted' | 'Rejected' | 'NotSupported';

export interface ChargingSchedulePeriod {
  startPeriod: number;
  limit: number;
  numberPhases?: number;
}

export interface ChargingSchedule {
  duration?: number;
  startSchedule?: string;
  chargingRateUnit: ChargingRateUnitType;
  chargingSchedulePeriod: ChargingSchedulePeriod[];
  minChargingRate?: number;
}

export interface ChargingProfile {
  chargingProfileId: number;
  transactionId?: number;
  stackLevel: number;
  chargingProfilePurpose: ChargingProfilePurposeType;
  chargingProfileKind: ChargingProfileKindType;
  recurrencyKind?: 'Daily' | 'Weekly';
  validFrom?: string;
  validTo?: string;
  chargingSchedule: ChargingSchedule;
}

export interface SetChargingProfileRequest {
  connectorId: number;
  csChargingProfiles: ChargingProfile;
}

export interface SetChargingProfileResponse {
  status: ChargingProfileStatus;
}

// ─── OCPP RPC message frame types ─────────────────────────────────────────────

export type OcppMessageType = 2 | 3 | 4;  // CALL | CALLRESULT | CALLERROR

export type OcppCall = [2, string, string, Record<string, unknown>];
export type OcppCallResult = [3, string, Record<string, unknown>];
export type OcppCallError = [4, string, string, string, Record<string, unknown>];
export type OcppMessage = OcppCall | OcppCallResult | OcppCallError;
