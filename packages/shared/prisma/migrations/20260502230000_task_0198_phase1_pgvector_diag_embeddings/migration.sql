-- TASK-0198 Phase 1 PR #3 — pgvector + DiagKnowledgeDoc embedding columns.
--
-- Enables the pgvector extension (idempotent), adds the embedding +
-- provenance columns to DiagKnowledgeDoc, and creates an HNSW index for
-- cosine-similarity retrieval. Cosine ops because the OpenAI
-- text-embedding-3-* family produces unit-normalized vectors, where
-- cosine and inner-product similarity agree.

-- Extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- AlterTable
ALTER TABLE "DiagKnowledgeDoc" ADD COLUMN     "embeddedAt" TIMESTAMP(3),
ADD COLUMN     "embedding" vector(1536),
ADD COLUMN     "embeddingModel" TEXT,
ADD COLUMN     "embeddingProvider" TEXT,
ADD COLUMN     "embeddingVersion" TEXT;

-- HNSW cosine index over rows that have an embedding and aren't
-- superseded. Partial index keeps it small and avoids index bloat
-- on draft/manual rows that haven't been embedded yet.
CREATE INDEX "DiagKnowledgeDoc_embedding_hnsw_cosine"
  ON "DiagKnowledgeDoc"
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE "embedding" IS NOT NULL AND "supersededAt" IS NULL;
