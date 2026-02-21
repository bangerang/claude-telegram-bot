/**
 * Memory Service - Main entry point for AI memory system
 *
 * Provides a unified interface for:
 * - Conversation tracking and summaries
 * - Decision recording
 * - Pattern learning
 * - Task history
 * - Semantic search
 */

export * from "./db";
export * from "./embeddings";
export * from "./summarize";
export * from "./learning";

import {
  getDb,
  createConversation,
  updateConversation,
  getRecentConversations,
  addDecision,
  getDecisions,
  recordPattern,
  getPatterns,
  addTask,
  getRecentTasks,
  addKnowledge,
  getKnowledge,
  recordFeedback,
  type Conversation,
  type Decision,
  type Pattern,
  type Task,
  type Knowledge,
} from "./db";

import {
  storeEmbedding,
  semanticSearch,
  type SearchResult,
} from "./embeddings";

// Check if any embedding API key is available
const EMBEDDINGS_ENABLED = !!(process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY);

/**
 * Safely store embedding - skips if no API key available
 */
async function safeStoreEmbedding(
  sourceType: "conversation" | "decision" | "task" | "knowledge" | "pattern",
  sourceId: string | number,
  text: string
): Promise<void> {
  if (!EMBEDDINGS_ENABLED) {
    return; // Skip embeddings when API key not set
  }
  try {
    await storeEmbedding(sourceType, sourceId, text);
  } catch (error) {
    console.warn(`Failed to store embedding: ${error}`);
  }
}

// ============================================
// High-Level Memory API
// ============================================

/**
 * Start tracking a new conversation
 */
export async function startConversation(
  sessionId: string,
  projectPath?: string
): Promise<void> {
  createConversation(sessionId, projectPath);
}

/**
 * End a conversation with a summary
 */
export async function endConversation(
  sessionId: string,
  options?: {
    title?: string;
    summary?: string;
    topics?: string[];
    messageCount?: number;
    tokenCount?: number;
  }
): Promise<void> {
  updateConversation(sessionId, {
    ended_at: new Date().toISOString(),
    ...options,
  });

  // Store embedding for semantic search
  if (options?.summary) {
    const searchText = [
      options.title,
      options.summary,
      options.topics?.join(", "),
    ]
      .filter(Boolean)
      .join(" - ");

    await safeStoreEmbedding("conversation", sessionId, searchText);
  }
}

/**
 * Record an important decision made during a conversation
 */
export async function rememberDecision(
  category: string,
  description: string,
  options?: {
    conversationId?: string;
    projectPath?: string;
    context?: string;
    alternatives?: string[];
  }
): Promise<number> {
  const id = addDecision(category, description, options);

  // Store embedding
  const searchText = `${category}: ${description}${options?.context ? ` - ${options.context}` : ""}`;
  await safeStoreEmbedding("decision", id, searchText);

  return id;
}

/**
 * Record a learned pattern or preference
 */
export async function learnPattern(
  category: string,
  pattern: string,
  options?: {
    examples?: string[];
    conversationId?: string;
  }
): Promise<number> {
  const id = recordPattern(category, pattern, options);

  // Store embedding (only on first observation)
  const searchText = `${category} pattern: ${pattern}`;
  await safeStoreEmbedding("pattern", id, searchText);

  return id;
}

/**
 * Record a completed task
 */
export async function recordTask(
  description: string,
  options?: {
    conversationId?: string;
    projectPath?: string;
    outcome?: string;
    status?: string;
    filesModified?: string[];
    filesCreated?: string[];
    turns?: number;
  }
): Promise<number> {
  const id = addTask(description, options);

  // Store embedding
  const searchText = `Task: ${description}${options?.outcome ? ` - ${options.outcome}` : ""}`;
  await safeStoreEmbedding("task", id, searchText);

  return id;
}

/**
 * Store a piece of knowledge
 */
export async function remember(
  category: string,
  subject: string,
  content: string,
  options?: {
    projectPath?: string;
    conversationId?: string;
  }
): Promise<number> {
  const id = addKnowledge(category, subject, content, options);

  // Store embedding
  const searchText = `${category} - ${subject}: ${content}`;
  await safeStoreEmbedding("knowledge", id, searchText);

  return id;
}

/**
 * Record user feedback for learning
 */
export function recordUserFeedback(
  type: "correction" | "praise" | "complaint" | "preference",
  content: string,
  options?: {
    conversationId?: string;
    context?: string;
  }
): number {
  return recordFeedback(type, content, options);
}

// ============================================
// Search and Retrieval
// ============================================

/**
 * Search memory using semantic similarity
 */
export async function searchMemory(
  query: string,
  options?: {
    types?: ("conversation" | "decision" | "task" | "knowledge" | "pattern")[];
    limit?: number;
  }
): Promise<SearchResult[]> {
  if (!EMBEDDINGS_ENABLED) {
    return []; // Return empty when embeddings not available
  }
  try {
    return await semanticSearch(query, {
      sourceTypes: options?.types,
      limit: options?.limit,
    });
  } catch (error) {
    console.warn(`Semantic search failed: ${error}`);
    return [];
  }
}

/**
 * Get relevant context for a conversation
 * Combines recent items with semantic search
 */
export async function getRelevantContext(
  projectPath?: string,
  query?: string
): Promise<{
  recentConversations: Conversation[];
  activeDecisions: Decision[];
  learnedPatterns: Pattern[];
  recentTasks: Task[];
  projectKnowledge: Knowledge[];
  semanticMatches?: SearchResult[];
}> {
  const context = {
    recentConversations: getRecentConversations(5),
    activeDecisions: getDecisions({ projectPath, activeOnly: true, limit: 10 }),
    learnedPatterns: getPatterns({ minConfidence: 0.6, limit: 10 }),
    recentTasks: getRecentTasks({ projectPath, limit: 10 }),
    projectKnowledge: getKnowledge({ projectPath, currentOnly: true, limit: 20 }),
    semanticMatches: undefined as SearchResult[] | undefined,
  };

  // Add semantic search results if query provided
  if (query) {
    context.semanticMatches = await searchMemory(query, { limit: 5 });
  }

  return context;
}

/**
 * Format context for injection into conversation
 */
export function formatContextForPrompt(context: Awaited<ReturnType<typeof getRelevantContext>>): string {
  const parts: string[] = [];

  // Active decisions for this project
  if (context.activeDecisions.length > 0) {
    parts.push("**Active Decisions:**");
    for (const d of context.activeDecisions.slice(0, 5)) {
      parts.push(`- [${d.category}] ${d.description}`);
    }
    parts.push("");
  }

  // Learned patterns
  if (context.learnedPatterns.length > 0) {
    parts.push("**Learned Preferences:**");
    for (const p of context.learnedPatterns.slice(0, 5)) {
      parts.push(`- [${p.category}] ${p.pattern} (confidence: ${(p.confidence * 100).toFixed(0)}%)`);
    }
    parts.push("");
  }

  // Recent tasks
  if (context.recentTasks.length > 0) {
    parts.push("**Recent Tasks:**");
    for (const t of context.recentTasks.slice(0, 5)) {
      const status = t.status === "completed" ? "✓" : t.status === "partial" ? "◐" : "✗";
      parts.push(`- ${status} ${t.description}`);
    }
    parts.push("");
  }

  // Project knowledge
  if (context.projectKnowledge.length > 0) {
    parts.push("**Project Knowledge:**");
    for (const k of context.projectKnowledge.slice(0, 5)) {
      parts.push(`- [${k.category}] ${k.subject}: ${k.content.slice(0, 100)}...`);
    }
    parts.push("");
  }

  // Semantic matches
  if (context.semanticMatches && context.semanticMatches.length > 0) {
    parts.push("**Relevant Memory:**");
    for (const m of context.semanticMatches) {
      const relevance = (m.similarity * 100).toFixed(0);
      parts.push(`- (${relevance}% match) ${m.text.slice(0, 100)}...`);
    }
    parts.push("");
  }

  return parts.length > 0 ? parts.join("\n") : "";
}

// ============================================
// Initialization
// ============================================

/**
 * Initialize the memory database
 * Call this on application startup
 */
export function initializeMemory(): void {
  try {
    getDb(); // This creates the database if needed
    console.log("Memory database initialized");
  } catch (error) {
    console.warn(`Failed to initialize memory database: ${error}`);
  }
}
