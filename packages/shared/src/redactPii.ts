/**
 * TASK-0198 Phase 1 — PII redaction.
 *
 * Pure function. Takes a string and returns a redacted copy + a per-field
 * count of what was redacted. The diagnostics evidence builder calls this
 * before assembling LLM context so the LLM never sees raw driver/payment
 * data.
 *
 * Posture: DEFAULT-REDACT-IF-UNCERTAIN. We tolerate over-redaction (a
 * legitimate string accidentally matching a regex) far more than under-
 * redaction. Adding new patterns is cheap; recovering from a leaked
 * Stripe customer id in an LLM transcript is not.
 *
 * Patterns covered:
 *   - VIN                17 chars [A-HJ-NPR-Z0-9] (excludes I/O/Q per ISO 3779)
 *   - email              standard local@host with strict-ish host validation
 *   - phone (US-shape)   +1 ###-###-####, (###) ###-####, ##########
 *   - Stripe ids         cus_, pm_, seti_, pi_, sub_, card_, src_, ch_, in_, evt_
 *   - generic UUIDs      8-4-4-4-12 hex (catches Clerk/Keycloak user ids,
 *                        driver-table primary keys, anything UUID-shaped that
 *                        could be a personal identifier)
 *   - "user_..." ids     Clerk style (user_*) when not at the start of a word
 *   - bearer tokens      Authorization: Bearer <jwt> patterns
 *
 * Redactions are placeholder-replaced (e.g. "[redacted:email]") so the
 * LLM still sees that *something* was there — improves answer quality
 * vs. silently dropping the token. The redaction summary records counts
 * keyed by field, persisted in DiagMessage.redactionsAppliedJson.
 */

export interface RedactionSummary {
  /** {fieldName: occurrenceCount}, omits keys with zero count. */
  counts: Record<string, number>;
  /** True when at least one redaction was applied. */
  redacted: boolean;
}

export interface RedactPiiResult {
  text: string;
  summary: RedactionSummary;
}

interface Pattern {
  name: string;
  /** Must be a global RegExp. */
  pattern: RegExp;
}

// Patterns are evaluated in the order declared. Order matters because the
// phone regex matches any 10-digit run, including trailing digits embedded
// in Stripe/Clerk ids ("cus_..._1234567890"). Run prefixed-id patterns
// FIRST so those tokens become "[redacted:stripe_id]" placeholders before
// the phone matcher gets a chance. UUIDs go last because they're the
// broadest pattern.
const PATTERNS: Pattern[] = [
  // VIN — 17 chars, excludes I/O/Q. Word-bounded.
  {
    name: 'vin',
    pattern: /\b[A-HJ-NPR-Z0-9]{17}\b/g,
  },
  // Email — local@host. Slightly conservative on host TLD (≥2 chars).
  {
    name: 'email',
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  },
  // Stripe ids — broad prefix list. The trailing identifier portion is
  // [A-Za-z0-9]{14,} which covers all current Stripe formats (test/live).
  // Must run BEFORE phone so the trailing digits inside a Stripe id
  // aren't independently swallowed by the phone matcher.
  {
    name: 'stripe_id',
    pattern: /\b(?:cus|pm|seti|pi|sub|card|src|ch|in|evt|tok|cs|po|fee|txn|trr|prc|prod|price|disp|file|sku|inv)_[A-Za-z0-9]{14,}\b/g,
  },
  // Clerk-style user ids (user_*). Same ordering reasoning as stripe_id.
  {
    name: 'clerk_user_id',
    pattern: /\buser_[A-Za-z0-9]{16,}\b/g,
  },
  // Bearer tokens. Run before phone in case the JWT signature contains
  // a digit run that would otherwise be mistaken for a phone number.
  {
    name: 'bearer_token',
    pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/g,
  },
  // Phone — US-style. Catches +1, (###) ###-####, ###-###-####, raw 10-digits.
  {
    name: 'phone',
    pattern: /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
  },
  // Generic UUIDs — last because they're the broadest pattern.
  {
    name: 'uuid',
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  },
];

/**
 * Redact PII from `input`. Returns the redacted text and a summary of
 * what was replaced. Safe on null/undefined-ish inputs (returns empty).
 */
export function redactPii(input: string | null | undefined): RedactPiiResult {
  const counts: Record<string, number> = {};
  if (!input) return { text: '', summary: { counts, redacted: false } };

  let text = input;
  for (const { name, pattern } of PATTERNS) {
    // Reset lastIndex defensively even though /g + .replace handles it.
    pattern.lastIndex = 0;
    const placeholder = `[redacted:${name}]`;
    text = text.replace(pattern, () => {
      counts[name] = (counts[name] ?? 0) + 1;
      return placeholder;
    });
  }

  return {
    text,
    summary: {
      counts,
      redacted: Object.values(counts).some((n) => n > 0),
    },
  };
}

/**
 * Apply redactPii recursively over a JSON-shaped value. Strings are
 * redacted; numbers/booleans/null pass through; arrays and plain objects
 * are walked. Cycles are broken by depth limit (default 12) — deep
 * cycles imply non-JSON shapes that shouldn't reach here anyway.
 *
 * Returns the redacted value plus an aggregated summary across all
 * strings encountered.
 */
export function redactPiiDeep(value: unknown, maxDepth = 12): { value: unknown; summary: RedactionSummary } {
  const aggregate: Record<string, number> = {};
  const walked = walk(value, 0);

  function walk(v: unknown, depth: number): unknown {
    if (depth > maxDepth) return v;
    if (typeof v === 'string') {
      const r = redactPii(v);
      for (const [k, n] of Object.entries(r.summary.counts)) {
        aggregate[k] = (aggregate[k] ?? 0) + n;
      }
      return r.text;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v)) out[k] = walk(vv, depth + 1);
      return out;
    }
    return v;
  }

  return {
    value: walked,
    summary: {
      counts: aggregate,
      redacted: Object.values(aggregate).some((n) => n > 0),
    },
  };
}
