/**
 * Embeddings provider factory (TASK-0198 Phase 1, PR #3).
 *
 * Caller-facing entry point. Reads env config, instantiates the adapter,
 * caches it. Tests inject custom providers directly into evidenceBuilder
 * / seedKnowledgeBase rather than going through this factory.
 */

import { OpenAIEmbeddingsAdapter } from './openai';
import type { EmbeddingProvider, EmbeddingProviderOpts } from './types';
import { EmbeddingProviderError } from './types';

let cached: EmbeddingProvider | null = null;

export function getEmbeddingProvider(opts: EmbeddingProviderOpts = {}): EmbeddingProvider {
  if (cached && Object.keys(opts).length === 0) return cached;
  const providerId = opts.provider ?? process.env.EMBEDDINGS_PROVIDER ?? 'openai';
  let provider: EmbeddingProvider;
  switch (providerId) {
    case 'openai':
      provider = new OpenAIEmbeddingsAdapter(opts);
      break;
    default:
      throw new EmbeddingProviderError(
        `unknown EMBEDDINGS_PROVIDER='${providerId}'. Supported: 'openai'.`,
      );
  }
  if (Object.keys(opts).length === 0) cached = provider;
  return provider;
}

/** Test-only. Reset the cached provider so a fresh env can take effect. */
export function __resetEmbeddingProviderForTests(): void {
  cached = null;
}

export type { EmbeddingProvider, EmbeddingResult, EmbeddingProviderOpts } from './types';
export { EmbeddingProviderError } from './types';
