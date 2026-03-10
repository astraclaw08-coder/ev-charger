import { randomUUID } from 'node:crypto';

export const SUPPORTED_SCIM_EVENTS = [
  'user.created',
  'user.updated',
  'user.deactivated',
  'group.membership.changed',
] as const;

export type ScimEventType = typeof SUPPORTED_SCIM_EVENTS[number];

export type ScimProvisioningEvent = {
  id: string;
  type: ScimEventType;
  occurredAt: string;
  tenantId: string;
  actor?: {
    id?: string;
    displayName?: string;
    ip?: string;
  };
  user?: {
    externalId?: string;
    email?: string;
    givenName?: string;
    familyName?: string;
    active?: boolean;
    roles?: string[];
    groups?: string[];
  };
  group?: {
    externalId?: string;
    displayName?: string;
    members?: string[];
  };
  correlationId?: string;
  dryRun?: boolean;
  raw?: Record<string, unknown>;
};

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}

function toTrimmedString(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t.length ? t : undefined;
}

export function parseScimProvisioningEvent(input: unknown, typeFromPath: string): ScimProvisioningEvent {
  if (!isObject(input)) throw new Error('SCIM payload must be an object');

  if (!SUPPORTED_SCIM_EVENTS.includes(typeFromPath as ScimEventType)) {
    throw new Error(`Unsupported SCIM event type: ${typeFromPath}`);
  }

  const id = toTrimmedString(input.id) ?? randomUUID();
  const occurredAt = toTrimmedString(input.occurredAt) ?? new Date().toISOString();
  const tenantId = toTrimmedString(input.tenantId);
  if (!tenantId) throw new Error('SCIM event requires tenantId');

  const out: ScimProvisioningEvent = {
    id,
    type: typeFromPath as ScimEventType,
    occurredAt,
    tenantId,
    correlationId: toTrimmedString(input.correlationId),
    dryRun: input.dryRun === true,
  };

  if (isObject(input.actor)) {
    out.actor = {
      id: toTrimmedString(input.actor.id),
      displayName: toTrimmedString(input.actor.displayName),
      ip: toTrimmedString(input.actor.ip),
    };
  }

  if (isObject(input.user)) {
    out.user = {
      externalId: toTrimmedString(input.user.externalId),
      email: toTrimmedString(input.user.email)?.toLowerCase(),
      givenName: toTrimmedString(input.user.givenName),
      familyName: toTrimmedString(input.user.familyName),
      active: typeof input.user.active === 'boolean' ? input.user.active : undefined,
      roles: Array.isArray(input.user.roles) ? input.user.roles.filter((v): v is string => typeof v === 'string' && !!v.trim()) : undefined,
      groups: Array.isArray(input.user.groups) ? input.user.groups.filter((v): v is string => typeof v === 'string' && !!v.trim()) : undefined,
    };
  }

  if (isObject(input.group)) {
    out.group = {
      externalId: toTrimmedString(input.group.externalId),
      displayName: toTrimmedString(input.group.displayName),
      members: Array.isArray(input.group.members) ? input.group.members.filter((v): v is string => typeof v === 'string' && !!v.trim()) : undefined,
    };
  }

  out.raw = input;
  return out;
}
