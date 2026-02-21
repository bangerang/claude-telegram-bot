/**
 * Embeddings Service - Vector embeddings for semantic search
 *
 * Uses OpenRouter's embeddings API (OpenAI-compatible)
 * Falls back to direct OpenAI if OPENROUTER_API_KEY not set
 */

import OpenAI from "openai";
import { getDb } from "./db";

// Use a small, fast model - good balance of quality and speed
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;

let client: OpenAI | null = null;
let usingOpenRouter = false;

function getClient(): OpenAI {
  if (!client) {
    // Prefer OpenRouter if available
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (openrouterKey) {
      client = new OpenAI({
        apiKey: openrouterKey,
        baseURL: "https://openrouter.ai/api/v1",
      });
      usingOpenRouter = true;
    } else {
      // Fall back to direct OpenAI
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey) {
        throw new Error("No API key set - need OPENROUTER_API_KEY or OPENAI_API_KEY for embeddings");
      }
      client = new OpenAI({ apiKey: openaiKey });
    }
  }
  return client;
}

/**
 * Generate embedding for text
 */
export async function generateEmbedding(text: string): Promise<Float32Array> {
  const api = getClient();

  // OpenRouter uses full model path, direct OpenAI uses short name
  const model = usingOpenRouter ? EMBEDDING_MODEL : "text-embedding-3-small";

  const response = await api.embeddings.create({
    model,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  const data = response.data[0];
  if (!data || !data.embedding) {
    throw new Error("No embedding returned from API");
  }
  return new Float32Array(data.embedding);
}

/**
 * Store embedding in database
 */
export async function storeEmbedding(
  sourceType: "conversation" | "decision" | "task" | "knowledge" | "pattern",
  sourceId: string | number,
  text: string
): Promise<void> {
  const db = getDb();
  const embedding = await generateEmbedding(text);

  // Convert Float32Array to Buffer for storage
  const buffer = Buffer.from(embedding.buffer);

  db.run(
    `INSERT INTO embeddings (source_type, source_id, text, embedding, embedding_model)
     VALUES (?, ?, ?, ?, ?)`,
    [sourceType, String(sourceId), text, buffer, EMBEDDING_MODEL]
  );
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i] ?? 0;
    const bVal = b[i] ?? 0;
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Search result from semantic search
 */
export interface SearchResult {
  sourceType: string;
  sourceId: string;
  text: string;
  similarity: number;
}

/**
 * Semantic search across all embeddings
 */
export async function semanticSearch(
  query: string,
  options?: {
    sourceTypes?: string[];
    limit?: number;
    minSimilarity?: number;
  }
): Promise<SearchResult[]> {
  const db = getDb();
  const queryEmbedding = await generateEmbedding(query);

  // Build query
  let sql = `SELECT source_type, source_id, text, embedding FROM embeddings`;
  const params: any[] = [];

  if (options?.sourceTypes && options.sourceTypes.length > 0) {
    const placeholders = options.sourceTypes.map(() => "?").join(", ");
    sql += ` WHERE source_type IN (${placeholders})`;
    params.push(...options.sourceTypes);
  }

  const rows = db.query(sql).all(...params) as any[];

  // Calculate similarities
  const results: SearchResult[] = [];
  const minSimilarity = options?.minSimilarity ?? 0.3;

  for (const row of rows) {
    const storedEmbedding = new Float32Array(
      new Uint8Array(row.embedding).buffer
    );
    const similarity = cosineSimilarity(queryEmbedding, storedEmbedding);

    if (similarity >= minSimilarity) {
      results.push({
        sourceType: row.source_type,
        sourceId: row.source_id,
        text: row.text,
        similarity,
      });
    }
  }

  // Sort by similarity and limit
  results.sort((a, b) => b.similarity - a.similarity);
  const limit = options?.limit ?? 10;

  return results.slice(0, limit);
}

/**
 * Delete embeddings for a source
 */
export function deleteEmbeddings(
  sourceType: string,
  sourceId: string | number
): void {
  const db = getDb();
  db.run(
    `DELETE FROM embeddings WHERE source_type = ? AND source_id = ?`,
    [sourceType, String(sourceId)]
  );
}

/**
 * Check if embeddings exist for a source
 */
export function hasEmbedding(
  sourceType: string,
  sourceId: string | number
): boolean {
  const db = getDb();
  const result = db.query(
    `SELECT 1 FROM embeddings WHERE source_type = ? AND source_id = ? LIMIT 1`
  ).get(sourceType, String(sourceId));
  return result !== null;
}
