/**
 * TASK-0198 Phase 1, PR #3 — diagnostics RAG selftest.
 * Run: npx ts-node packages/api/src/lib/diagnostics/diagnostics.selftest.ts
 *
 * Hits the local dev Postgres (must have pgvector enabled). Uses a
 * deterministic fake embedding provider — no external API calls. Covers:
 *   - seedOne idempotency on unchanged body
 *   - seedOne supersede + version bump on changed body
 *   - buildEvidence KB retrieval with correct similarity ranking
 *   - buildEvidence redaction (PII never leaks into the bundle)
 *   - buildEvidence cross-model warning
 *   - buildEvidence scope guard (allowedSiteIds rejects out-of-scope)
 *
 * Cleans up after itself by deleting only the rows it created.
 */

import 'dotenv/config';
import { prisma } from '@ev-charger/shared';
import { seedOne, sha256 } from './seedKnowledgeBase';
import { buildEvidence } from './evidenceBuilder';
import type { EmbeddingProvider, EmbeddingResult } from '../embeddings';

let passed = 0;
let failed = 0;
function assert(c: boolean, name: string) {
  if (c) { passed++; console.log(`  ✅ ${name}`); }
  else   { failed++; console.error(`  ❌ ${name}`); }
}

const TEST_SLUG_PREFIX = '__selftest__/diag-';
const TEST_TAG = '__selftest__';

// Deterministic fake provider: produces a 1536-dim unit vector that's a
// linear combination of feature buckets keyed by lowercased word presence.
// Two strings sharing many words → high cosine similarity.
function makeFakeProvider(modelId = 'fake-model-v1', providerId = 'fake', dims = 1536): EmbeddingProvider {
  function hashWord(w: string, slot: number): number {
    let h = 5381;
    for (let i = 0; i < w.length; i++) h = ((h << 5) + h + w.charCodeAt(i)) | 0;
    return Math.abs((h ^ slot) % dims);
  }
  function embedText(text: string): number[] {
    const v = new Array<number>(dims).fill(0);
    const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const w of words) {
      // Drop two indices per word — denser feature than 1.
      v[hashWord(w, 0)] += 1;
      v[hashWord(w, 1)] += 1;
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dims; i++) v[i] /= norm;
    return v;
  }
  return {
    providerId, modelId, dimensions: dims,
    async embed(text: string): Promise<EmbeddingResult> {
      return { vector: embedText(text), provider: providerId, model: modelId };
    },
    async embedBatch(texts: string[]) {
      return Promise.all(texts.map((t) => this.embed(t)));
    },
  };
}

async function cleanup() {
  await prisma.diagKnowledgeDoc.deleteMany({
    where: { slug: { startsWith: TEST_SLUG_PREFIX } },
  });
}

async function main() {
  console.log('\n=== diagnostics selftest ===');
  await cleanup();

  const provider = makeFakeProvider();

  // ─── seedOne: insert ─────────────────────────────────────────
  console.log('\n--- seedOne: fresh insert ---');
  {
    const doc = {
      slug: `${TEST_SLUG_PREFIX}alpha`,
      title: 'Alpha doc',
      body: 'Charger PowerSwitchFailure happens when the SuspendedEVSE state oscillates rapidly during 0 A dwell on LOOP firmware.',
      tags: [TEST_TAG],
    };
    const r1 = await seedOne(doc, { embeddings: provider });
    assert(r1.action === 'inserted', `action=inserted (got ${r1.action})`);
    assert(r1.newVersion === 1, 'version=1');

    const row = await prisma.diagKnowledgeDoc.findFirst({
      where: { slug: doc.slug, supersededAt: null },
    });
    assert(row !== null, 'row persisted');
    assert(row?.embeddingProvider === 'fake', 'provider audited');
    assert(row?.embeddingModel === 'fake-model-v1', 'model audited');
    assert(row?.bodyHash === sha256(doc.body), 'bodyHash matches');
  }

  // ─── seedOne: idempotent on unchanged body ───────────────────
  console.log('\n--- seedOne: re-run with unchanged body is no-op ---');
  {
    const doc = {
      slug: `${TEST_SLUG_PREFIX}alpha`,
      title: 'Alpha doc',
      body: 'Charger PowerSwitchFailure happens when the SuspendedEVSE state oscillates rapidly during 0 A dwell on LOOP firmware.',
      tags: [TEST_TAG],
    };
    const r2 = await seedOne(doc, { embeddings: provider });
    assert(r2.action === 'unchanged', `second run unchanged (got ${r2.action})`);
    const all = await prisma.diagKnowledgeDoc.findMany({
      where: { slug: doc.slug },
    });
    assert(all.length === 1, 'still only one row');
  }

  // ─── seedOne: changed body supersedes prior + bumps version ─
  console.log('\n--- seedOne: changed body supersedes + bumps version ---');
  {
    const doc = {
      slug: `${TEST_SLUG_PREFIX}alpha`,
      title: 'Alpha doc',
      body: 'Updated body — PowerSwitchFailure now also covers the new firmware variant.',
      tags: [TEST_TAG],
    };
    const r3 = await seedOne(doc, { embeddings: provider });
    assert(r3.action === 'superseded', `action=superseded (got ${r3.action})`);
    assert(r3.newVersion === 2, 'version=2');
    const all = await prisma.diagKnowledgeDoc.findMany({
      where: { slug: doc.slug },
      orderBy: { version: 'asc' },
    });
    assert(all.length === 2, 'two rows total');
    assert(all[0].supersededAt !== null, 'old row supersededAt set');
    assert(all[1].supersededAt === null, 'new row not superseded');
  }

  // ─── buildEvidence: retrieval finds the seeded doc ──────────
  console.log('\n--- buildEvidence: KB retrieval ranks similar doc highest ---');
  {
    // Seed a few unrelated docs to force the ranking to actually work.
    await seedOne({
      slug: `${TEST_SLUG_PREFIX}beta`,
      title: 'Unrelated billing doc',
      body: 'Stripe SetupIntent creation flow for driver onboarding billing card capture.',
      tags: [TEST_TAG],
    }, { embeddings: provider });
    await seedOne({
      slug: `${TEST_SLUG_PREFIX}gamma`,
      title: 'Reservation expiry',
      body: 'Reservation hold expires after holdExpiresAt; driver must rebook for a new charging slot.',
      tags: [TEST_TAG],
    }, { embeddings: provider });

    const bundle = await buildEvidence(
      { text: 'why is the charger throwing PowerSwitchFailure during the 0 A dwell?' },
      { topK: 3 },
      provider,
    );
    assert(bundle.kbHits.length > 0, 'at least one KB hit');
    // The "Updated body — PowerSwitchFailure now also covers..." (alpha v2)
    // shares the most relevant terms (PowerSwitchFailure, charger, firmware)
    // with the query.
    const top = bundle.kbHits[0];
    assert(top.slug === `${TEST_SLUG_PREFIX}alpha`, `top hit is alpha (got ${top.slug})`);
    assert(top.similarity > 0, 'similarity > 0');
    assert(top.embeddingProvider === 'fake', 'hit carries provider audit');
    assert(top.embeddingModel === 'fake-model-v1', 'hit carries model audit');
    assert(bundle.warnings.length === 0, 'no warnings when single provider');
  }

  // ─── buildEvidence: PII redaction on the query ──────────────
  console.log('\n--- buildEvidence: redaction applied to query ---');
  {
    const bundle = await buildEvidence(
      { text: 'driver email jane.doe@example.com plugged in vehicle 1HGCM82633A123456' },
      { topK: 1 },
      provider,
    );
    assert(!bundle.query.text.includes('jane.doe@example.com'), 'email not in redacted query');
    assert(!bundle.query.text.includes('1HGCM82633A123456'), 'VIN not in redacted query');
    assert((bundle.query.redactionSummary.counts.email ?? 0) >= 1, 'query email redaction counted');
    assert((bundle.query.redactionSummary.counts.vin ?? 0) === 1, 'query VIN redaction counted');
    assert(bundle.redactionSummary.redacted === true, 'aggregate flag true');
  }

  // ─── buildEvidence: cross-provider warning ──────────────────
  console.log('\n--- buildEvidence: warns on heterogeneous embedding providers ---');
  {
    const otherProvider = makeFakeProvider('other-model-v1', 'other-provider');
    // Re-seed alpha with a different provider so the catalog is mixed.
    await seedOne({
      slug: `${TEST_SLUG_PREFIX}delta`,
      title: 'Mixed-provider sentinel',
      body: 'A doc embedded with a different provider and model name.',
      tags: [TEST_TAG],
    }, { embeddings: otherProvider });

    const bundle = await buildEvidence(
      { text: 'a doc embedded with a different provider' },
      { topK: 5 },
      provider, // query embedded with original provider
    );
    const hasMixedWarning = bundle.warnings.some((w) => w.includes('mixed-embedding-providers'));
    assert(hasMixedWarning, 'warning mentions mixed providers');
  }

  // ─── buildEvidence: scope guard rejects out-of-scope siteId ─
  console.log('\n--- buildEvidence: rejects siteId outside allowedSiteIds ---');
  {
    let threw = false;
    try {
      await buildEvidence(
        { text: 'any' },
        { siteId: 'site-X', allowedSiteIds: ['site-A', 'site-B'] },
        provider,
      );
    } catch {
      threw = true;
    }
    assert(threw, 'throws when scope.siteId is outside allowedSiteIds');
  }

  console.log('\n--- cleanup ---');
  await cleanup();
  console.log('  test rows removed.');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main()
  .then(() => prisma.$disconnect().then(() => process.exit(0)))
  .catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
