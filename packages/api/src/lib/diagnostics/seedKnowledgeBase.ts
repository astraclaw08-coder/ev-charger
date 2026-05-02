/**
 * TASK-0198 Phase 1, PR #3 — KB seed loader.
 *
 * Walks a list of repo-relative markdown paths, computes SHA-256 of each
 * body, compares to existing DiagKnowledgeDoc rows by (slug, bodyHash),
 * and:
 *   - inserts a fresh row when slug is new
 *   - bumps version + supersedes the prior row when bodyHash changed
 *   - no-ops when bodyHash matches the latest version (idempotent re-run)
 *
 * For each newly persisted row, requests an embedding from the provider
 * and writes vector + provenance via raw SQL (Prisma client cannot bind
 * pgvector columns natively).
 *
 * v1 corpus is hand-curated (see DEFAULT_SEED_PATHS). Later PRs add a
 * portal CRUD surface and an automated git-walk. Operator-runnable
 * via `seedKnowledgeBase.cli.ts`.
 */

import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';
import { prisma } from '@ev-charger/shared';
import { redactPii } from '@ev-charger/shared';
import type { EmbeddingProvider } from '../embeddings';

export interface SeedDoc {
  /** Repo-relative path used as `slug`. */
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  source?: string;
}

export interface SeedResult {
  slug: string;
  action: 'inserted' | 'superseded' | 'unchanged' | 'embed-failed';
  newVersion?: number;
  error?: string;
}

export interface SeedOptions {
  /** Embedding provider — pass test/mock impls in selftests. */
  embeddings: EmbeddingProvider;
  /** When false, skip the embedding step (writes/updates the row but
   *  leaves embedding NULL). Useful for content-only smoke tests when
   *  no embeddings provider key is configured. */
  embed?: boolean;
}

/**
 * Default v1 corpus — task findings, fault-relevant docs, ops references.
 * Repo paths are relative to the repository root. Operator can extend by
 * passing a custom list to `seedKnowledgeBase()`.
 */
export const DEFAULT_SEED_PATHS: string[] = [
  'tasks/task-0208-phase3-bug-alwayson-not-honored.md',
  'tasks/task-0208-phase3-bug-release-stacklevel-loses-to-baseline.md',
  'tasks/task-0198-claude-next-steps.md',
  'docs/fleet-policies.md',
];

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Read a markdown file from the repo root, derive a title from the first
 * H1 (`# ...`) line, fall back to the filename. Returns a SeedDoc shape.
 */
export async function readSeedDocFromFs(repoRoot: string, relPath: string): Promise<SeedDoc | null> {
  try {
    const fullPath = path.join(repoRoot, relPath);
    const body = await readFile(fullPath, 'utf-8');
    const titleMatch = body.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1]?.trim() ?? path.basename(relPath);
    return {
      slug: relPath,
      title,
      body,
      tags: deriveTags(relPath),
      source: 'repo',
    };
  } catch {
    return null;
  }
}

function deriveTags(relPath: string): string[] {
  const parts = relPath.split('/');
  const tags: string[] = [];
  if (parts[0]) tags.push(parts[0]);                  // tasks | docs | ...
  const fileTaskMatch = parts[parts.length - 1]?.match(/task-(\d+)/);
  if (fileTaskMatch) tags.push(`task-${fileTaskMatch[1]}`);
  return tags;
}

// ─── Core upsert flow ────────────────────────────────────────────

/**
 * Persist a single SeedDoc. Idempotent: if the latest non-superseded row
 * for `slug` has the same `bodyHash`, do nothing. Otherwise supersede
 * the prior latest row and insert a new version. Caller-supplied
 * embedding provider is invoked once per inserted/superseded row.
 *
 * Does NOT throw on embedding failures — records `embed-failed` and
 * persists the row with a NULL embedding so the seed run as a whole
 * doesn't abort. Operator can re-run the seeder later to fill in any
 * missing embeddings (the loader detects missing-embedding rows and
 * back-fills on next run if the bodyHash already matches).
 */
export async function seedOne(doc: SeedDoc, opts: SeedOptions): Promise<SeedResult> {
  const bodyHash = sha256(doc.body);

  const latest = await prisma.diagKnowledgeDoc.findFirst({
    where: { slug: doc.slug, supersededAt: null },
    orderBy: { version: 'desc' },
  });

  if (latest && latest.bodyHash === bodyHash) {
    // Body unchanged — but maybe embedding is missing (prior run failed).
    if (opts.embed !== false && !latest.embeddingProvider) {
      const result = await tryEmbedAndWrite(latest.id, doc, opts.embeddings);
      return { slug: doc.slug, action: result === 'ok' ? 'unchanged' : 'embed-failed', newVersion: latest.version };
    }
    return { slug: doc.slug, action: 'unchanged', newVersion: latest.version };
  }

  // New or changed — supersede prior, insert next version.
  const nextVersion = latest ? latest.version + 1 : 1;

  if (latest) {
    await prisma.diagKnowledgeDoc.update({
      where: { id: latest.id },
      data: { supersededAt: new Date() },
    });
  }

  const created = await prisma.diagKnowledgeDoc.create({
    data: {
      slug: doc.slug,
      title: doc.title,
      body: doc.body,
      bodyHash,
      tags: doc.tags ?? [],
      source: doc.source ?? 'repo',
      version: nextVersion,
    },
  });

  if (opts.embed === false) {
    return { slug: doc.slug, action: latest ? 'superseded' : 'inserted', newVersion: nextVersion };
  }

  const embedResult = await tryEmbedAndWrite(created.id, doc, opts.embeddings);
  return {
    slug: doc.slug,
    action: embedResult === 'ok' ? (latest ? 'superseded' : 'inserted') : 'embed-failed',
    newVersion: nextVersion,
    error: embedResult === 'ok' ? undefined : embedResult,
  };
}

async function tryEmbedAndWrite(
  rowId: string,
  doc: SeedDoc,
  provider: EmbeddingProvider,
): Promise<'ok' | string> {
  try {
    // Redact PII from the body before sending to a third-party provider.
    // Per platform constraint: default-redact-if-uncertain. The redacted
    // text is what the embedding represents, which is the right semantics
    // — retrieval queries will be redacted too.
    const { text: safe } = redactPii(`${doc.title}\n\n${doc.body}`);
    const result = await provider.embed(safe);
    if (result.vector.length !== provider.dimensions) {
      return `vector dim mismatch: got ${result.vector.length}, expected ${provider.dimensions}`;
    }
    // pgvector requires raw SQL — Prisma client doesn't bind vector cols.
    // Quote the vector as `'[v1,v2,...]'::vector`. Vector values are
    // floats; we serialize directly. Safe because numbers can't contain
    // SQL-injection chars.
    const vectorLiteral = `[${result.vector.join(',')}]`;
    await prisma.$executeRawUnsafe(
      `UPDATE "DiagKnowledgeDoc"
         SET "embedding" = $1::vector,
             "embeddingProvider" = $2,
             "embeddingModel" = $3,
             "embeddingVersion" = $4,
             "embeddedAt" = NOW()
       WHERE id = $5`,
      vectorLiteral,
      result.provider,
      result.model,
      result.version ?? null,
      rowId,
    );
    return 'ok';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Bulk seed entry point. Reads docs from the repo, persists each via
 * `seedOne()`, returns per-doc results.
 */
export async function seedKnowledgeBase(opts: {
  embeddings: EmbeddingProvider;
  paths?: string[];
  repoRoot?: string;
  embed?: boolean;
}): Promise<SeedResult[]> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const paths = opts.paths ?? DEFAULT_SEED_PATHS;
  const docs: SeedDoc[] = [];
  for (const p of paths) {
    const d = await readSeedDocFromFs(repoRoot, p);
    if (d) docs.push(d);
  }
  const out: SeedResult[] = [];
  for (const d of docs) {
    try {
      out.push(await seedOne(d, { embeddings: opts.embeddings, embed: opts.embed }));
    } catch (err) {
      out.push({
        slug: d.slug,
        action: 'embed-failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
