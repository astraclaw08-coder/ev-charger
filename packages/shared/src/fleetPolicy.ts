/**
 * Fleet policy validation (TASK-0208 Phase 2.5).
 *
 * Centralized validator for FleetPolicy inputs. Used by the API before any
 * create/update/enable write, so API + (future) portal share one source of
 * truth for validation rules and error codes.
 *
 * Rules enforced here:
 *   1. name           — non-empty, ≤80 chars (trimmed)
 *   2. idTagPrefix    — /^[A-Z0-9][A-Z0-9_-]{1,31}$/ (2–32 chars, uppercase)
 *   3. maxAmps        — integer in [6, 80] (lower bound matches enforcement
 *                       reality — most charger firmware ignores/clamps below
 *                       ~6 A, so there's no point allowing 1–5 A values)
 *   4. ocppStackLevel — integer in [51, 98]   (above charger default 50,
 *                       below emergency 99)
 *   5. windowsJson    — { windows: FleetWindow[] } parseable by
 *                       normalizeFleetWindows; must yield ≥1 valid window
 *                       on enable (create/update may accept 0 in DRAFT).
 *   6. Prefix collision (per site): no other non-DISABLED policy at the
 *                       same site may have idTagPrefix that is a prefix of
 *                       ours, or vice-versa. Exact dupes are caught by the
 *                       DB @@unique([siteId, idTagPrefix]); this rule catches
 *                       substring overlaps (e.g. "FLEET-" vs "FLEET-ACME-").
 *                       DISABLED rows are ignored.
 *
 * Not enforced here (by design):
 *   - Cross-policy window overlap at same site → allowed; first-match-by-
 *     prefix is the runtime discriminator.
 *   - Window overlap within the same policy → allowed; expandToMinuteOfWeek
 *     merges adjacent/overlapping intervals.
 */

import { normalizeFleetWindows, type FleetWindow } from './fleetWindow';

// ─── Types ──────────────────────────────────────────────────────────────────

export type FleetPolicyStatusLiteral = 'DRAFT' | 'ENABLED' | 'DISABLED';

export type FleetPolicyInput = {
  name: string;
  idTagPrefix: string;
  maxAmps: number;
  ocppStackLevel?: number; // defaults to 90
  windowsJson: unknown;    // raw { windows: FleetWindow[] } or FleetWindow[]
  notes?: string | null;
  // ─ TASK-0208 Phase 3 Slice A — Fleet-Auto activation fields ─
  /** When true, fleet gating is "always allowed" 24/7 regardless of windowsJson. */
  alwaysOn?: boolean;
  /**
   * idTag the OCPP server uses for server-initiated RemoteStartTransaction
   * on plug-in (Slice C). Same character class as idTagPrefix. Optional in
   * Slice A so legacy Hybrid-B inputs continue to validate; Slice B's API
   * surface will require it for new/edited policies and enforce site-scoped
   * uniqueness against ENABLED + DRAFT siblings.
   */
  autoStartIdTag?: string;
};

/** An existing policy at the same site, used for collision checks. */
export type SiblingPolicy = {
  id: string;
  idTagPrefix: string;
  status: FleetPolicyStatusLiteral;
  /** Slice A: optional for backwards-compat with callers that don't yet read it. */
  autoStartIdTag?: string | null;
};

export type FleetPolicyValidationError = {
  field:
    | 'name'
    | 'idTagPrefix'
    | 'maxAmps'
    | 'ocppStackLevel'
    | 'windowsJson'
    | 'notes'
    | 'alwaysOn'
    | 'autoStartIdTag';
  code:
    | 'REQUIRED'
    | 'TOO_LONG'
    | 'INVALID_FORMAT'
    | 'OUT_OF_RANGE'
    | 'MALFORMED'
    | 'EMPTY_WINDOWS'
    | 'PREFIX_COLLISION'
    | 'AUTOSTART_COLLISION';
  message: string;
  detail?: Record<string, unknown>;
};

export type FleetPolicyValidationResult =
  | { ok: true; normalized: NormalizedFleetPolicy }
  | { ok: false; errors: FleetPolicyValidationError[] };

export type NormalizedFleetPolicy = {
  name: string;
  idTagPrefix: string;
  maxAmps: number;
  ocppStackLevel: number;
  windows: FleetWindow[];
  windowsJson: { windows: FleetWindow[] };
  notes: string | null;
  alwaysOn: boolean;
  autoStartIdTag: string | null;
};

// ─── Constants ──────────────────────────────────────────────────────────────

/** Min current the scheduler will enforce. Firmware tends to clamp below ~6 A. */
export const FLEET_POLICY_MIN_AMPS = 6;
/** Max current any fleet policy can declare. Matches Phase-1 default cap. */
export const FLEET_POLICY_MAX_AMPS = 80;
/** Stack-level floor — must be above CHARGER baseline (50). */
export const FLEET_POLICY_MIN_STACK_LEVEL = 51;
/** Stack-level ceiling — must stay below emergency (99). */
export const FLEET_POLICY_MAX_STACK_LEVEL = 98;
/** Default stack level — matches FleetPolicy.ocppStackLevel schema default. */
export const FLEET_POLICY_DEFAULT_STACK_LEVEL = 90;

export const FLEET_POLICY_NAME_MAX_LEN = 80;
export const FLEET_POLICY_NOTES_MAX_LEN = 2000;

// 2–32 chars, uppercase alnum/underscore/hyphen, must start with alnum.
export const FLEET_POLICY_PREFIX_RE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

// autoStartIdTag (Phase 3 Slice A): same character class as idTagPrefix BUT
// capped at 20 chars to fit OCPP 1.6 RemoteStartTransaction.idTag —
// CiString20Type. A value longer than 20 chars would be rejected by the
// charger at runtime, so we reject at validation time.
export const FLEET_POLICY_AUTO_START_ID_TAG_MAX_LEN = 20;
export const FLEET_POLICY_AUTO_START_ID_TAG_RE = /^[A-Z0-9][A-Z0-9_-]{1,19}$/;

// ─── Public validator ──────────────────────────────────────────────────────

export function validateFleetPolicyInput(
  input: FleetPolicyInput,
  context: {
    /** All other policies at the same site (any status). Used for collision. */
    siblingPolicies: SiblingPolicy[];
    /** When updating, the id of the policy being edited — skipped in collision check. */
    selfId?: string;
    /**
     * Whether windowsJson is required to yield ≥1 valid window.
     * Create/update-in-DRAFT may accept an empty list so operators can save
     * work in progress. Enable always requires at least one window.
     */
    requireWindows?: boolean;
  },
): FleetPolicyValidationResult {
  const errors: FleetPolicyValidationError[] = [];

  // name
  const name = (input.name ?? '').trim();
  if (name.length === 0) {
    errors.push({ field: 'name', code: 'REQUIRED', message: 'name is required' });
  } else if (name.length > FLEET_POLICY_NAME_MAX_LEN) {
    errors.push({
      field: 'name',
      code: 'TOO_LONG',
      message: `name must be ≤${FLEET_POLICY_NAME_MAX_LEN} chars`,
      detail: { maxLen: FLEET_POLICY_NAME_MAX_LEN, gotLen: name.length },
    });
  }

  // idTagPrefix
  const prefix = (input.idTagPrefix ?? '').trim();
  if (prefix.length === 0) {
    errors.push({ field: 'idTagPrefix', code: 'REQUIRED', message: 'idTagPrefix is required' });
  } else if (!FLEET_POLICY_PREFIX_RE.test(prefix)) {
    errors.push({
      field: 'idTagPrefix',
      code: 'INVALID_FORMAT',
      message: 'idTagPrefix must be 2–32 chars, uppercase letters/digits/underscore/hyphen, starting with letter or digit',
      detail: { pattern: FLEET_POLICY_PREFIX_RE.source },
    });
  }

  // maxAmps
  const maxAmps = Number(input.maxAmps);
  if (!Number.isInteger(maxAmps) || maxAmps < FLEET_POLICY_MIN_AMPS || maxAmps > FLEET_POLICY_MAX_AMPS) {
    errors.push({
      field: 'maxAmps',
      code: 'OUT_OF_RANGE',
      message: `maxAmps must be an integer in [${FLEET_POLICY_MIN_AMPS}, ${FLEET_POLICY_MAX_AMPS}]`,
      detail: { min: FLEET_POLICY_MIN_AMPS, max: FLEET_POLICY_MAX_AMPS, got: input.maxAmps },
    });
  }

  // ocppStackLevel
  const stackLevel = input.ocppStackLevel == null
    ? FLEET_POLICY_DEFAULT_STACK_LEVEL
    : Number(input.ocppStackLevel);
  if (
    !Number.isInteger(stackLevel)
    || stackLevel < FLEET_POLICY_MIN_STACK_LEVEL
    || stackLevel > FLEET_POLICY_MAX_STACK_LEVEL
  ) {
    errors.push({
      field: 'ocppStackLevel',
      code: 'OUT_OF_RANGE',
      message: `ocppStackLevel must be an integer in [${FLEET_POLICY_MIN_STACK_LEVEL}, ${FLEET_POLICY_MAX_STACK_LEVEL}]`,
      detail: {
        min: FLEET_POLICY_MIN_STACK_LEVEL,
        max: FLEET_POLICY_MAX_STACK_LEVEL,
        got: input.ocppStackLevel,
      },
    });
  }

  // windowsJson — normalize, then check shape expectations
  const normalizedWindows = normalizeFleetWindows(input.windowsJson);
  const requireWindows = context.requireWindows ?? false;
  if (requireWindows && normalizedWindows.length === 0) {
    errors.push({
      field: 'windowsJson',
      code: 'EMPTY_WINDOWS',
      message: 'at least one valid window is required to enable this policy',
    });
  }
  // MALFORMED signal: caller passed something non-null that yielded 0 rows —
  // only surface when caller explicitly required windows, otherwise empty is
  // a valid DRAFT state.
  if (
    requireWindows
    && input.windowsJson != null
    && normalizedWindows.length === 0
    && !hasRecognizableWindowsShape(input.windowsJson)
  ) {
    // Already counted as EMPTY_WINDOWS above; skip duplicate MALFORMED.
  }

  // notes (optional)
  const notes = normalizeNotes(input.notes);
  if (notes != null && notes.length > FLEET_POLICY_NOTES_MAX_LEN) {
    errors.push({
      field: 'notes',
      code: 'TOO_LONG',
      message: `notes must be ≤${FLEET_POLICY_NOTES_MAX_LEN} chars`,
      detail: { maxLen: FLEET_POLICY_NOTES_MAX_LEN, gotLen: notes.length },
    });
  }

  // alwaysOn (optional, defaults to false). Strict boolean only — no truthy
  // coercion. Slice A keeps the runtime engine unchanged; Slice C will read
  // this flag to short-circuit window evaluation.
  const alwaysOn =
    input.alwaysOn === undefined ? false : input.alwaysOn === true;
  if (input.alwaysOn !== undefined && typeof input.alwaysOn !== 'boolean') {
    errors.push({
      field: 'alwaysOn',
      code: 'INVALID_FORMAT',
      message: 'alwaysOn must be a boolean',
      detail: { got: typeof input.alwaysOn },
    });
  }

  // autoStartIdTag (Phase 3 Slice A — optional in this slice; Slice B
  // requires it on the API for new/edited policies). When supplied, validate
  // format. Site-scoped uniqueness is enforced separately via
  // findAutoStartIdTagCollision() so callers that haven't loaded siblings
  // yet still get format feedback.
  const rawAutoStart = input.autoStartIdTag;
  let autoStartIdTag: string | null = null;
  if (rawAutoStart !== undefined && rawAutoStart !== null) {
    const trimmed = String(rawAutoStart).trim();
    if (trimmed.length === 0) {
      // Treat empty string as "not provided" rather than an error in Slice A;
      // Slice B's API REQUIRED check will surface explicit-empty separately.
      autoStartIdTag = null;
    } else if (!FLEET_POLICY_AUTO_START_ID_TAG_RE.test(trimmed)) {
      errors.push({
        field: 'autoStartIdTag',
        code: 'INVALID_FORMAT',
        message:
          `autoStartIdTag must be 2–${FLEET_POLICY_AUTO_START_ID_TAG_MAX_LEN} chars, uppercase letters/digits/underscore/hyphen, starting with letter or digit ` +
          '(OCPP 1.6 RemoteStartTransaction.idTag is CiString20Type)',
        detail: {
          pattern: FLEET_POLICY_AUTO_START_ID_TAG_RE.source,
          maxLen: FLEET_POLICY_AUTO_START_ID_TAG_MAX_LEN,
          gotLen: trimmed.length,
        },
      });
      autoStartIdTag = trimmed;
    } else {
      autoStartIdTag = trimmed;
      // Site-scoped autoStartIdTag collision: any non-DISABLED sibling with
      // the same value is an exact conflict (no prefix-substring rule here —
      // autoStartIdTag is the literal OCPP idTag the server will send, so
      // exact-match is the only ambiguity at runtime).
      const colliding = findAutoStartIdTagCollision(
        autoStartIdTag,
        context.siblingPolicies,
        context.selfId,
      );
      if (colliding) {
        errors.push({
          field: 'autoStartIdTag',
          code: 'AUTOSTART_COLLISION',
          message:
            `autoStartIdTag "${autoStartIdTag}" is already in use by policy ` +
            `${colliding.id} (status ${colliding.status}) at the same site`,
          detail: {
            conflictingPolicyId: colliding.id,
            conflictingStatus: colliding.status,
          },
        });
      }
    }
  }

  // Prefix-collision check — only meaningful when prefix itself is well-formed.
  if (prefix.length > 0 && FLEET_POLICY_PREFIX_RE.test(prefix)) {
    const colliding = findPrefixCollision(prefix, context.siblingPolicies, context.selfId);
    if (colliding) {
      errors.push({
        field: 'idTagPrefix',
        code: 'PREFIX_COLLISION',
        message:
          `idTagPrefix "${prefix}" overlaps with existing policy "${colliding.idTagPrefix}" ` +
          `(status ${colliding.status}) at the same site — one is a prefix of the other, ` +
          `which would cause ambiguous matching at Authorize`,
        detail: {
          conflictingPolicyId: colliding.id,
          conflictingPrefix: colliding.idTagPrefix,
          conflictingStatus: colliding.status,
        },
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    normalized: {
      name,
      idTagPrefix: prefix,
      maxAmps,
      ocppStackLevel: stackLevel,
      windows: normalizedWindows,
      windowsJson: { windows: normalizedWindows },
      notes,
      alwaysOn,
      autoStartIdTag,
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * True iff two prefixes overlap such that some idTag could match both.
 * Since runtime match is `idTag.startsWith(prefix)`, a shorter prefix that is
 * itself a prefix of the longer one creates ambiguity.
 */
export function prefixesCollide(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  return false;
}

function findPrefixCollision(
  prefix: string,
  siblings: SiblingPolicy[],
  selfId?: string,
): SiblingPolicy | null {
  for (const sib of siblings) {
    if (selfId && sib.id === selfId) continue;
    if (sib.status === 'DISABLED') continue;
    if (prefixesCollide(prefix, sib.idTagPrefix)) return sib;
  }
  return null;
}

/**
 * Site-scoped autoStartIdTag collision check (Phase 3 Slice A).
 *
 * Unlike idTagPrefix (which collides on substring overlap because runtime
 * matching is `idTag.startsWith(prefix)`), autoStartIdTag is the literal
 * idTag the OCPP server uses for server-initiated RemoteStartTransaction.
 * Two policies sharing the same autoStartIdTag at one site is operator
 * confusion at best and ambiguous attachment at worst — reject exact dupes.
 *
 * DISABLED siblings are ignored; same-policy (selfId) is skipped.
 *
 * Slice A: callers may omit `autoStartIdTag` on sibling rows (older code
 * paths). Those siblings are skipped silently — they cannot collide because
 * they don't carry a value to compare against.
 */
export function findAutoStartIdTagCollision(
  autoStartIdTag: string,
  siblings: SiblingPolicy[],
  selfId?: string,
): SiblingPolicy | null {
  for (const sib of siblings) {
    if (selfId && sib.id === selfId) continue;
    if (sib.status === 'DISABLED') continue;
    if (!sib.autoStartIdTag) continue;
    if (sib.autoStartIdTag === autoStartIdTag) return sib;
  }
  return null;
}

function hasRecognizableWindowsShape(raw: unknown): boolean {
  if (Array.isArray(raw)) return true;
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).windows)) return true;
  return false;
}

function normalizeNotes(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}
