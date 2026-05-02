/**
 * TASK-0198 Phase 1, PR #3 — RAG evidence builder.
 *
 * Given an operator's diagnostic query plus optional scope (chargerId,
 * siteId, time bounds), assemble a typed evidence bundle that the future
 * /diagnostics API (PR #4) will pass to the LLM. Evidence is composed of:
 *
 *   - kbHits          top-K KB doc snippets ranked by cosine similarity
 *                     to the query embedding (over DiagKnowledgeDoc rows
 *                     with non-null embedding, not superseded)
 *   - chargerEvents   recent ChargerEvent rows for the scoped charger(s)
 *   - chargerSnapshot current Charger row (status, lastHeartbeat, etc.)
 *                     for chargerId scope
 *   - recentSessions  recent Session rows on the scoped charger(s)
 *   - remoteCommands  recent OcppLog rows for OUTBOUND remote commands
 *                     (RemoteStart/Stop/SetChargingProfile) and their
 *                     INBOUND responses
 *   - redactionSummary aggregated redaction counts for everything in
 *                     the bundle (PII never reaches the LLM raw)
 *
 * All string fields in returned data are run through `redactPii()` /
 * `redactPiiDeep()` before the bundle is returned. Posture is
 * default-redact-if-uncertain.
 *
 * Provider/model audit: each kbHit carries the provider/model/version
 * the doc was embedded with so the API layer can warn the LLM (and the
 * operator) when the catalog is heterogeneous after a model change.
 */

import { prisma, redactPii, redactPiiDeep } from '@ev-charger/shared';
import type { RedactionSummary } from '@ev-charger/shared';
import type { EmbeddingProvider } from '../embeddings';

// ─── Types ───────────────────────────────────────────────────────

export interface EvidenceQuery {
  /** Operator-typed natural-language query. Will be redacted before embedding. */
  text: string;
}

export interface EvidenceScope {
  /** Restrict charger-level evidence to this single charger when set. */
  chargerId?: string;
  /** Site scope. When set + chargerId unset, charger evidence aggregates over the site. */
  siteId?: string;
  /** Operator's allowed sites (from claims.siteIds). Empty array means "no restriction". */
  allowedSiteIds?: string[];
  /** Recency window for charger events / sessions / remote commands. */
  since?: Date;
  /** Top-K KB hits. Default 5. */
  topK?: number;
  /** Recent-event row cap. Default 50. */
  maxChargerEvents?: number;
  /** Recent-sessions row cap. Default 10. */
  maxSessions?: number;
  /** Recent remote-commands row cap. Default 20. */
  maxRemoteCommands?: number;
}

export interface KbHit {
  id: string;
  slug: string;
  title: string;
  /** Snippet of body (first ~600 chars). Already redacted. */
  snippet: string;
  tags: string[];
  /** Cosine similarity in [0, 1]; higher is more similar. */
  similarity: number;
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingVersion: string | null;
}

export interface ChargerEventBundle {
  id: string;
  chargerId: string;
  connectorId: number | null;
  kind: string;
  severity: string;
  errorCode: string | null;
  vendorErrorCode: string | null;
  payloadSummary: unknown;
  detectedAt: string;
}

export interface ChargerSnapshot {
  id: string;
  ocppId: string;
  vendor: string;
  model: string;
  status: string;
  lastHeartbeat: string | null;
}

export interface RecentSession {
  id: string;
  status: string;
  startedAt: string;
  stoppedAt: string | null;
  kwhDelivered: number | null;
  fleetPolicyId: string | null;
}

export interface RemoteCommandRecord {
  id: string;
  action: string;
  direction: 'INBOUND' | 'OUTBOUND';
  payload: unknown;
  createdAt: string;
}

export interface EvidenceBundle {
  query: { text: string; redactionSummary: RedactionSummary };
  kbHits: KbHit[];
  chargerEvents: ChargerEventBundle[];
  chargerSnapshot: ChargerSnapshot | null;
  recentSessions: RecentSession[];
  remoteCommands: RemoteCommandRecord[];
  /** Aggregate of every redaction applied across the entire bundle. */
  redactionSummary: RedactionSummary;
  /** Embedding provider/model used at retrieval time. */
  retrievalProvider: { provider: string; model: string; version: string | null };
  /** Warnings (e.g. heterogeneous embedding providers across kbHits). */
  warnings: string[];
}

const DEFAULTS = {
  topK: 5,
  maxChargerEvents: 50,
  maxSessions: 10,
  maxRemoteCommands: 20,
  snippetChars: 600,
};

const REMOTE_COMMAND_ACTIONS = [
  'RemoteStartTransaction',
  'RemoteStartTransactionResponse',
  'RemoteStopTransaction',
  'RemoteStopTransactionResponse',
  'SetChargingProfile',
  'SetChargingProfileResponse',
  'ClearChargingProfile',
  'ClearChargingProfileResponse',
  'Reset',
  'ResetResponse',
  'TriggerMessage',
  'TriggerMessageResponse',
  'ChangeConfiguration',
  'ChangeConfigurationResponse',
];

// ─── Main entry point ───────────────────────────────────────────

export async function buildEvidence(
  query: EvidenceQuery,
  scope: EvidenceScope,
  embeddings: EmbeddingProvider,
): Promise<EvidenceBundle> {
  const aggregate: Record<string, number> = {};
  const warnings: string[] = [];
  const since = scope.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // default 7 days
  const topK = scope.topK ?? DEFAULTS.topK;

  // 1. Redact + embed the query
  const redactedQuery = redactPii(query.text);
  bumpCounts(aggregate, redactedQuery.summary.counts);

  // Site-scope guard: if the operator passed a chargerId/siteId and
  // allowedSiteIds is set, refuse to expand outside it.
  if (
    scope.allowedSiteIds &&
    scope.allowedSiteIds.length > 0 &&
    !scope.allowedSiteIds.includes('*') &&
    scope.siteId &&
    !scope.allowedSiteIds.includes(scope.siteId)
  ) {
    throw new Error(`scope.siteId not in operator allowedSiteIds`);
  }

  // 2. KB retrieval (skip when empty corpus or when embedding fails)
  let kbHits: KbHit[] = [];
  let queryEmbedding: { vector: number[]; provider: string; model: string; version?: string } | null = null;
  try {
    queryEmbedding = await embeddings.embed(redactedQuery.text);
    kbHits = await retrieveKb(queryEmbedding.vector, topK);
  } catch (err) {
    warnings.push(`kb-retrieval-failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Provenance + cross-model warning
  if (kbHits.length > 0 && queryEmbedding) {
    const distinct = new Set(kbHits.map((h) => `${h.embeddingProvider}/${h.embeddingModel}`));
    distinct.add(`${queryEmbedding.provider}/${queryEmbedding.model}`);
    if (distinct.size > 1) {
      warnings.push(
        `mixed-embedding-providers across kb hits + query (${[...distinct].join('; ')}); retrieval quality may degrade — consider re-seeding KB with the current model`,
      );
    }
  }

  // 3. Charger-scoped evidence
  let chargerEvents: ChargerEventBundle[] = [];
  let chargerSnapshot: ChargerSnapshot | null = null;
  let recentSessions: RecentSession[] = [];
  let remoteCommands: RemoteCommandRecord[] = [];

  const chargerScope = await resolveChargerScope(scope);
  if (chargerScope.chargerIds.length > 0) {
    chargerEvents = await fetchRecentChargerEvents(chargerScope.chargerIds, since, scope.maxChargerEvents ?? DEFAULTS.maxChargerEvents);
    if (chargerScope.chargerIds.length === 1) {
      chargerSnapshot = await fetchChargerSnapshot(chargerScope.chargerIds[0]);
    }
    recentSessions = await fetchRecentSessions(chargerScope.chargerIds, since, scope.maxSessions ?? DEFAULTS.maxSessions);
    remoteCommands = await fetchRecentRemoteCommands(chargerScope.chargerIds, since, scope.maxRemoteCommands ?? DEFAULTS.maxRemoteCommands);
  }

  // 4. Redact every payload in the bundle. KB snippets came in already
  // redacted (the seed loader stored redacted bodies via redactPii); we
  // redact again here for defense-in-depth (cheap + idempotent).
  const finalKbHits = kbHits.map((h) => {
    const r = redactPii(h.snippet);
    bumpCounts(aggregate, r.summary.counts);
    return { ...h, snippet: r.text };
  });

  const redactedEvents = chargerEvents.map((e) => {
    const r = redactPiiDeep(e.payloadSummary);
    bumpCounts(aggregate, r.summary.counts);
    return { ...e, payloadSummary: r.value };
  });

  const redactedRemote = remoteCommands.map((c) => {
    const r = redactPiiDeep(c.payload);
    bumpCounts(aggregate, r.summary.counts);
    return { ...c, payload: r.value };
  });

  const summary: RedactionSummary = {
    counts: aggregate,
    redacted: Object.values(aggregate).some((n) => n > 0),
  };

  return {
    query: { text: redactedQuery.text, redactionSummary: redactedQuery.summary },
    kbHits: finalKbHits,
    chargerEvents: redactedEvents,
    chargerSnapshot,
    recentSessions,
    remoteCommands: redactedRemote,
    redactionSummary: summary,
    retrievalProvider: queryEmbedding
      ? { provider: queryEmbedding.provider, model: queryEmbedding.model, version: queryEmbedding.version ?? null }
      : { provider: embeddings.providerId, model: embeddings.modelId, version: embeddings.version ?? null },
    warnings,
  };
}

// ─── Internals ──────────────────────────────────────────────────

function bumpCounts(into: Record<string, number>, add: Record<string, number>) {
  for (const [k, v] of Object.entries(add)) into[k] = (into[k] ?? 0) + v;
}

async function retrieveKb(queryVector: number[], topK: number): Promise<KbHit[]> {
  // pgvector: lower cosine distance = more similar. We compute similarity
  // = 1 - distance for an intuitive [0, 1] downstream value.
  const literal = `[${queryVector.join(',')}]`;
  const rows = await prisma.$queryRawUnsafe<Array<{
    id: string;
    slug: string;
    title: string;
    body: string;
    tags: string[];
    distance: number;
    embeddingProvider: string | null;
    embeddingModel: string | null;
    embeddingVersion: string | null;
  }>>(
    `SELECT id, slug, title, body, tags,
            ("embedding" <=> $1::vector) AS distance,
            "embeddingProvider", "embeddingModel", "embeddingVersion"
       FROM "DiagKnowledgeDoc"
      WHERE "embedding" IS NOT NULL AND "supersededAt" IS NULL
      ORDER BY "embedding" <=> $1::vector
      LIMIT $2::int`,
    literal,
    topK,
  );
  return rows.map((r) => {
    const snippet = r.body.length <= DEFAULTS.snippetChars
      ? r.body
      : `${r.body.slice(0, DEFAULTS.snippetChars)}…`;
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      snippet,
      tags: r.tags ?? [],
      similarity: Math.max(0, Math.min(1, 1 - Number(r.distance ?? 1))),
      embeddingProvider: r.embeddingProvider,
      embeddingModel: r.embeddingModel,
      embeddingVersion: r.embeddingVersion,
    };
  });
}

async function resolveChargerScope(scope: EvidenceScope): Promise<{ chargerIds: string[] }> {
  if (scope.chargerId) {
    // Verify the charger belongs to an allowed site (when restriction is set)
    if (scope.allowedSiteIds && scope.allowedSiteIds.length > 0 && !scope.allowedSiteIds.includes('*')) {
      const c = await prisma.charger.findUnique({
        where: { id: scope.chargerId },
        select: { siteId: true },
      });
      if (!c || !c.siteId || !scope.allowedSiteIds.includes(c.siteId)) {
        return { chargerIds: [] };
      }
    }
    return { chargerIds: [scope.chargerId] };
  }
  if (scope.siteId) {
    const ids = await prisma.charger.findMany({
      where: { siteId: scope.siteId },
      select: { id: true },
    });
    return { chargerIds: ids.map((c) => c.id) };
  }
  return { chargerIds: [] };
}

async function fetchRecentChargerEvents(
  chargerIds: string[],
  since: Date,
  limit: number,
): Promise<ChargerEventBundle[]> {
  const rows = await prisma.chargerEvent.findMany({
    where: { chargerId: { in: chargerIds }, detectedAt: { gte: since } },
    orderBy: { detectedAt: 'desc' },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    chargerId: r.chargerId,
    connectorId: r.connectorId,
    kind: r.kind,
    severity: r.severity,
    errorCode: r.errorCode,
    vendorErrorCode: r.vendorErrorCode,
    payloadSummary: r.payloadSummary,
    detectedAt: r.detectedAt.toISOString(),
  }));
}

async function fetchChargerSnapshot(chargerId: string): Promise<ChargerSnapshot | null> {
  const c = await prisma.charger.findUnique({
    where: { id: chargerId },
    select: {
      id: true, ocppId: true, vendor: true, model: true,
      status: true, lastHeartbeat: true,
    },
  });
  if (!c) return null;
  return {
    id: c.id,
    ocppId: c.ocppId,
    vendor: c.vendor,
    model: c.model,
    status: String(c.status),
    lastHeartbeat: c.lastHeartbeat?.toISOString() ?? null,
  };
}

async function fetchRecentSessions(
  chargerIds: string[],
  since: Date,
  limit: number,
): Promise<RecentSession[]> {
  const rows = await prisma.session.findMany({
    where: {
      connector: { chargerId: { in: chargerIds } },
      OR: [{ startedAt: { gte: since } }, { stoppedAt: { gte: since } }],
    },
    orderBy: { startedAt: 'desc' },
    take: limit,
    select: {
      id: true, status: true, startedAt: true, stoppedAt: true,
      kwhDelivered: true, fleetPolicyId: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    status: String(r.status),
    startedAt: r.startedAt.toISOString(),
    stoppedAt: r.stoppedAt?.toISOString() ?? null,
    kwhDelivered: r.kwhDelivered ?? null,
    fleetPolicyId: r.fleetPolicyId ?? null,
  }));
}

async function fetchRecentRemoteCommands(
  chargerIds: string[],
  since: Date,
  limit: number,
): Promise<RemoteCommandRecord[]> {
  const rows = await prisma.ocppLog.findMany({
    where: {
      chargerId: { in: chargerIds },
      action: { in: REMOTE_COMMAND_ACTIONS },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true, action: true, direction: true, payload: true, createdAt: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    action: r.action ?? 'unknown',
    direction: r.direction as 'INBOUND' | 'OUTBOUND',
    payload: r.payload,
    createdAt: r.createdAt.toISOString(),
  }));
}
