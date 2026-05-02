/**
 * OpenAI embeddings adapter (TASK-0198 Phase 1, PR #3).
 *
 * Calls api.openai.com/v1/embeddings directly with `OPENAI_API_KEY`.
 * Used ONLY for embeddings — does not produce chat completions and is
 * not the diagnostics LLM. The diagnostics LLM stays on OpenRouter.
 *
 * Caller is responsible for redacting PII from the input text before
 * calling embed(). The adapter does no transformation beyond batching.
 */

import type {
  EmbeddingProvider,
  EmbeddingProviderOpts,
  EmbeddingResult,
} from './types';
import { EmbeddingProviderError } from './types';

const OPENAI_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMS = 1536;

export interface OpenAIEmbeddingsAdapterOpts extends EmbeddingProviderOpts {
  /** Override fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class OpenAIEmbeddingsAdapter implements EmbeddingProvider {
  readonly providerId = 'openai';
  readonly modelId: string;
  readonly version?: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIEmbeddingsAdapterOpts = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    if (!apiKey) {
      throw new EmbeddingProviderError(
        'OPENAI_API_KEY is required for OpenAI embeddings adapter (set env or pass apiKey).',
      );
    }
    this.apiKey = apiKey;
    this.modelId = opts.model ?? process.env.EMBEDDINGS_MODEL ?? DEFAULT_MODEL;
    this.dimensions = Number(opts.dimensions ?? process.env.EMBEDDINGS_DIMENSIONS ?? DEFAULT_DIMS);
    if (!Number.isFinite(this.dimensions) || this.dimensions <= 0) {
      throw new EmbeddingProviderError(`invalid dimensions: ${this.dimensions}`);
    }
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const [first] = await this.embedBatch([text]);
    return first;
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];
    const res = await this.fetchImpl(`${OPENAI_BASE}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelId,
        input: texts,
        // text-embedding-3-* supports `dimensions` parameter for
        // explicit dim selection (matters when the schema column is
        // vector(N) — must match exactly).
        dimensions: this.dimensions,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new EmbeddingProviderError(
        `openai embeddings HTTP ${res.status}: ${body.slice(0, 500)}`,
      );
    }
    const json = (await res.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
      model?: string;
    };
    if (!json.data || !Array.isArray(json.data)) {
      throw new EmbeddingProviderError('openai embeddings response missing data array');
    }
    // OpenAI guarantees response order matches input order, but harden
    // anyway by sorting on `index` when present.
    const ordered = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (ordered.length !== texts.length) {
      throw new EmbeddingProviderError(
        `openai embeddings response length mismatch (got ${ordered.length}, expected ${texts.length})`,
      );
    }
    return ordered.map((d, i) => {
      if (!Array.isArray(d.embedding)) {
        throw new EmbeddingProviderError(`openai embeddings missing vector for input index ${i}`);
      }
      if (d.embedding.length !== this.dimensions) {
        throw new EmbeddingProviderError(
          `openai embeddings dim mismatch (got ${d.embedding.length}, expected ${this.dimensions})`,
        );
      }
      return {
        vector: d.embedding,
        provider: this.providerId,
        model: json.model ?? this.modelId,
        version: this.version,
      };
    });
  }
}
