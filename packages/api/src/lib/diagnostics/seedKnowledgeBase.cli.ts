#!/usr/bin/env ts-node
/**
 * TASK-0198 Phase 1, PR #3 — KB seed loader CLI.
 *
 * Usage:
 *   # default corpus, embed via env-configured provider
 *   npx ts-node packages/api/src/lib/diagnostics/seedKnowledgeBase.cli.ts
 *
 *   # custom paths (repo-relative)
 *   npx ts-node ... --paths tasks/foo.md docs/bar.md
 *
 *   # skip embeddings (e.g. when no OPENAI_API_KEY is set; row is
 *   # inserted with NULL embedding and back-filled on next run)
 *   SEED_EMBED=false npx ts-node ...
 */

import 'dotenv/config';
import path from 'path';
import { getEmbeddingProvider } from '../embeddings';
import {
  DEFAULT_SEED_PATHS,
  seedKnowledgeBase,
} from './seedKnowledgeBase';

async function main() {
  const argPaths: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--paths') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) argPaths.push(argv[++i]);
    }
  }
  const paths = argPaths.length > 0 ? argPaths : DEFAULT_SEED_PATHS;
  const embed = process.env.SEED_EMBED !== 'false';
  const repoRoot = process.env.SEED_REPO_ROOT ?? findRepoRoot();

  console.log('========================================');
  console.log('  TASK-0198 KB seed loader');
  console.log('========================================');
  console.log(`  repoRoot : ${repoRoot}`);
  console.log(`  embed    : ${embed}`);
  console.log(`  paths    :`);
  for (const p of paths) console.log(`             ${p}`);
  console.log('----------------------------------------');

  const embeddings = embed
    ? getEmbeddingProvider()
    : ({
        providerId: 'noop',
        modelId: 'noop',
        dimensions: 0,
        async embed() { throw new Error('embed disabled'); },
        async embedBatch() { throw new Error('embed disabled'); },
      } as any);

  const results = await seedKnowledgeBase({ embeddings, paths, repoRoot, embed });

  const summary: Record<string, number> = {};
  for (const r of results) summary[r.action] = (summary[r.action] ?? 0) + 1;

  console.log('  RESULTS:');
  for (const r of results) {
    console.log(`    ${r.action.padEnd(14)} ${r.slug}${r.newVersion ? ` v${r.newVersion}` : ''}${r.error ? ` (${r.error})` : ''}`);
  }
  console.log('----------------------------------------');
  console.log('  SUMMARY:');
  for (const [k, v] of Object.entries(summary)) console.log(`    ${k.padEnd(14)} ${v}`);
}

function findRepoRoot(): string {
  // CLI is at packages/api/src/lib/diagnostics/seedKnowledgeBase.cli.ts.
  // Repo root is 5 levels up from this file.
  return path.resolve(__dirname, '../../../../..');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed] fatal:', err);
    process.exit(1);
  });
