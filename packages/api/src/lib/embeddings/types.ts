/**
 * TASK-0198 Phase 1 — embeddings provider abstraction.
 *
 * The diagnostics RAG path needs vector embeddings for the KB seed
 * loader (build-time) and for query-time retrieval (run-time). OpenRouter
 * does NOT expose an embeddings endpoint, and per platform constraints we
 * keep OpenRouter as the *primary* chat/LLM gateway. Embeddings are a
 * separate provider capability with its own configurable adapter; OpenAI
 * is acceptable for embeddings even though it must NOT be the default
 * diagnostics LLM.
 *
 * The provider interface returns the embedding plus the provenance triple
 * (provider, model, version) so each row we persist captures exactly which
 * model produced it. Mixed provider/model values across the catalog after
 * a model change get warned about at retrieval time but don't block reads.
 */

export interface EmbeddingResult {
  /** Floating-point vector. Length must equal `dimensions`. */
  vector: number[];
  /** Provider id, e.g. "openai". Persisted for audit. */
  provider: string;
  /** Model id, e.g. "text-embedding-3-small". Persisted for audit. */
  model: string;
  /** Optional version pin (e.g. an OpenAI fingerprint or release date). */
  version?: string;
}

export interface EmbeddingProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly version?: string;
  readonly dimensions: number;
  embed(text: string): Promise<EmbeddingResult>;
  /** Convenience batch entry point. Default impl can serialize via embed(). */
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
}

/**
 * Provider config sources, in precedence order:
 *   1. opts overrides (explicit caller config — used by selftests)
 *   2. process.env (EMBEDDINGS_PROVIDER, EMBEDDINGS_MODEL, EMBEDDINGS_DIMENSIONS, OPENAI_API_KEY)
 *   3. defaults (openai / text-embedding-3-small / 1536)
 */
export interface EmbeddingProviderOpts {
  provider?: string;
  model?: string;
  dimensions?: number;
  apiKey?: string;
}

export class EmbeddingProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingProviderError';
  }
}
