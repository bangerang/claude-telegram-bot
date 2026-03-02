/**
 * Memory Database - SQLite wrapper for persistent AI memory
 */

import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";

const MEMORY_DB_PATH = `${homedir()}/.ai/memory-db/memory.db`;
const SCHEMA_PATH = `${homedir()}/.ai/memory-db/schema.sql`;

let db: Database | null = null;

/**
 * Initialize the database connection
 */
export function getDb(): Database {
  if (!db) {
    // Ensure directory exists
    const dir = `${homedir()}/.ai/memory-db`;
    if (!existsSync(dir)) {
      throw new Error(`Memory database directory not found: ${dir}`);
    }

    // Create or open database
    db = new Database(MEMORY_DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");

    // Initialize schema if needed
    const schemaVersion = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'").get();
    if (!schemaVersion) {
      console.log("Initializing memory database schema...");
      const schema = readFileSync(SCHEMA_PATH, "utf-8");
      db.exec(schema);
      console.log("Memory database initialized");
    }
  }

  return db;
}

/**
 * Close the database connection
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ============================================
// CONVERSATIONS
// ============================================

export interface Conversation {
  id: string;
  started_at: string;
  ended_at?: string;
  title?: string;
  summary?: string;
  project_path?: string;
  message_count: number;
  token_count: number;
  user_sentiment?: string;
  topics?: string[];
}

export function createConversation(
  id: string,
  projectPath?: string
): void {
  const db = getDb();
  db.run(
    `INSERT OR IGNORE INTO conversations (id, project_path) VALUES (?, ?)`,
    [id, projectPath ?? null]
  );
}

export function updateConversation(
  id: string,
  updates: Partial<{
    title: string;
    summary: string;
    ended_at: string;
    message_count: number;
    token_count: number;
    user_sentiment: string;
    topics: string[];
  }>
): void {
  const db = getDb();
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.title !== undefined) {
    fields.push("title = ?");
    values.push(updates.title);
  }
  if (updates.summary !== undefined) {
    fields.push("summary = ?");
    values.push(updates.summary);
  }
  if (updates.ended_at !== undefined) {
    fields.push("ended_at = ?");
    values.push(updates.ended_at);
  }
  if (updates.message_count !== undefined) {
    fields.push("message_count = ?");
    values.push(updates.message_count);
  }
  if (updates.token_count !== undefined) {
    fields.push("token_count = ?");
    values.push(updates.token_count);
  }
  if (updates.user_sentiment !== undefined) {
    fields.push("user_sentiment = ?");
    values.push(updates.user_sentiment);
  }
  if (updates.topics !== undefined) {
    fields.push("topics = ?");
    values.push(JSON.stringify(updates.topics));
  }

  if (fields.length > 0) {
    values.push(id);
    db.run(`UPDATE conversations SET ${fields.join(", ")} WHERE id = ?`, values);
  }
}

export function getRecentConversations(limit = 10): Conversation[] {
  const db = getDb();
  const rows = db.query(`
    SELECT * FROM conversations
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit) as any[];

  return rows.map((row) => ({
    ...row,
    topics: row.topics ? JSON.parse(row.topics) : undefined,
  }));
}

// ============================================
// DECISIONS
// ============================================

export interface Decision {
  id: number;
  conversation_id?: string;
  project_path?: string;
  category: string;
  description: string;
  context?: string;
  alternatives?: string[];
  confidence: number;
  is_active: boolean;
  created_at: string;
}

export function addDecision(
  category: string,
  description: string,
  options?: {
    conversationId?: string;
    projectPath?: string;
    context?: string;
    alternatives?: string[];
    confidence?: number;
  }
): number {
  const db = getDb();
  const result = db.run(
    `INSERT INTO decisions (conversation_id, project_path, category, description, context, alternatives, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      options?.conversationId ?? null,
      options?.projectPath ?? null,
      category,
      description,
      options?.context ?? null,
      options?.alternatives ? JSON.stringify(options.alternatives) : null,
      options?.confidence ?? 1.0,
    ]
  );
  return Number(result.lastInsertRowid);
}

export function getDecisions(options?: {
  projectPath?: string;
  category?: string;
  activeOnly?: boolean;
  limit?: number;
}): Decision[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (options?.projectPath) {
    conditions.push("(project_path = ? OR project_path IS NULL)");
    params.push(options.projectPath);
  }
  if (options?.category) {
    conditions.push("category = ?");
    params.push(options.category);
  }
  if (options?.activeOnly !== false) {
    conditions.push("is_active = TRUE");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options?.limit ?? 50;

  const rows = db.query(`
    SELECT * FROM decisions
    ${where}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `).all(...params) as any[];

  return rows.map((row) => ({
    ...row,
    alternatives: row.alternatives ? JSON.parse(row.alternatives) : undefined,
  }));
}

// ============================================
// PATTERNS
// ============================================

export interface Pattern {
  id: number;
  category: string;
  pattern: string;
  examples?: string[];
  frequency: number;
  confidence: number;
  last_seen: string;
}

export function recordPattern(
  category: string,
  pattern: string,
  options?: {
    examples?: string[];
    conversationId?: string;
  }
): number {
  const db = getDb();

  // Check if pattern already exists
  const existing = db.query(
    `SELECT id, frequency, source_conversations FROM patterns
     WHERE category = ? AND pattern = ?`
  ).get(category, pattern) as any;

  if (existing) {
    // Update existing pattern
    const conversations = existing.source_conversations
      ? JSON.parse(existing.source_conversations)
      : [];
    if (options?.conversationId && !conversations.includes(options.conversationId)) {
      conversations.push(options.conversationId);
    }

    const newFrequency = existing.frequency + 1;
    const newConfidence = Math.min(1.0, 0.5 + newFrequency * 0.1);

    db.run(
      `UPDATE patterns SET
        frequency = ?,
        confidence = ?,
        last_seen = CURRENT_TIMESTAMP,
        source_conversations = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [newFrequency, newConfidence, JSON.stringify(conversations), existing.id]
    );

    return existing.id;
  }

  // Create new pattern
  const result = db.run(
    `INSERT INTO patterns (category, pattern, examples, source_conversations)
     VALUES (?, ?, ?, ?)`,
    [
      category,
      pattern,
      options?.examples ? JSON.stringify(options.examples) : null,
      options?.conversationId ? JSON.stringify([options.conversationId]) : null,
    ]
  );
  return Number(result.lastInsertRowid);
}

export function getPatterns(options?: {
  category?: string;
  minConfidence?: number;
  limit?: number;
}): Pattern[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (options?.category) {
    conditions.push("category = ?");
    params.push(options.category);
  }
  if (options?.minConfidence !== undefined) {
    conditions.push("confidence >= ?");
    params.push(options.minConfidence);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options?.limit ?? 50;

  const rows = db.query(`
    SELECT * FROM patterns
    ${where}
    ORDER BY confidence DESC, frequency DESC
    LIMIT ${limit}
  `).all(...params) as any[];

  return rows.map((row) => ({
    ...row,
    examples: row.examples ? JSON.parse(row.examples) : undefined,
  }));
}

// ============================================
// TASKS
// ============================================

export interface Task {
  id: number;
  conversation_id?: string;
  project_path?: string;
  description: string;
  outcome?: string;
  status: string;
  files_modified?: string[];
  files_created?: string[];
  started_at: string;
  completed_at?: string;
  turns: number;
}

export function addTask(
  description: string,
  options?: {
    conversationId?: string;
    projectPath?: string;
    outcome?: string;
    status?: string;
    filesModified?: string[];
    filesCreated?: string[];
    filesDeleted?: string[];
    turns?: number;
    lessonsLearned?: string;
  }
): number {
  const db = getDb();
  const result = db.run(
    `INSERT INTO tasks (
      conversation_id, project_path, description, outcome, status,
      files_modified, files_created, files_deleted, turns, lessons_learned,
      completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      options?.conversationId ?? null,
      options?.projectPath ?? null,
      description,
      options?.outcome ?? null,
      options?.status ?? "completed",
      options?.filesModified ? JSON.stringify(options.filesModified) : null,
      options?.filesCreated ? JSON.stringify(options.filesCreated) : null,
      options?.filesDeleted ? JSON.stringify(options.filesDeleted) : null,
      options?.turns ?? 1,
      options?.lessonsLearned ?? null,
    ]
  );
  return Number(result.lastInsertRowid);
}

export function getRecentTasks(options?: {
  projectPath?: string;
  limit?: number;
}): Task[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (options?.projectPath) {
    conditions.push("project_path = ?");
    params.push(options.projectPath);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options?.limit ?? 20;

  const rows = db.query(`
    SELECT * FROM tasks
    ${where}
    ORDER BY started_at DESC
    LIMIT ${limit}
  `).all(...params) as any[];

  return rows.map((row) => ({
    ...row,
    files_modified: row.files_modified ? JSON.parse(row.files_modified) : undefined,
    files_created: row.files_created ? JSON.parse(row.files_created) : undefined,
  }));
}

// ============================================
// KNOWLEDGE
// ============================================

export interface Knowledge {
  id: number;
  category: string;
  subject: string;
  content: string;
  project_path?: string;
  is_current: boolean;
  created_at: string;
}

export function addKnowledge(
  category: string,
  subject: string,
  content: string,
  options?: {
    projectPath?: string;
    source?: string;
    conversationId?: string;
  }
): number {
  const db = getDb();
  const result = db.run(
    `INSERT INTO knowledge (category, subject, content, project_path, source, source_conversation_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      category,
      subject,
      content,
      options?.projectPath ?? null,
      options?.source ?? null,
      options?.conversationId ?? null,
    ]
  );
  return Number(result.lastInsertRowid);
}

export function getKnowledge(options?: {
  category?: string;
  subject?: string;
  projectPath?: string;
  currentOnly?: boolean;
  limit?: number;
}): Knowledge[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (options?.category) {
    conditions.push("category = ?");
    params.push(options.category);
  }
  if (options?.subject) {
    conditions.push("subject LIKE ?");
    params.push(`%${options.subject}%`);
  }
  if (options?.projectPath) {
    conditions.push("(project_path = ? OR project_path IS NULL)");
    params.push(options.projectPath);
  }
  if (options?.currentOnly !== false) {
    conditions.push("is_current = TRUE");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options?.limit ?? 50;

  return db.query(`
    SELECT * FROM knowledge
    ${where}
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `).all(...params) as Knowledge[];
}

// ============================================
// FEEDBACK
// ============================================

export function recordFeedback(
  type: "correction" | "praise" | "complaint" | "preference",
  content: string,
  options?: {
    conversationId?: string;
    context?: string;
    affectedPatternId?: number;
    affectedDecisionId?: number;
  }
): number {
  const db = getDb();
  const result = db.run(
    `INSERT INTO feedback (conversation_id, type, content, context, affected_pattern_id, affected_decision_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      options?.conversationId ?? null,
      type,
      content,
      options?.context ?? null,
      options?.affectedPatternId ?? null,
      options?.affectedDecisionId ?? null,
    ]
  );
  return Number(result.lastInsertRowid);
}

// ============================================
// WORK SESSIONS
// ============================================

export interface WorkSession {
  id: number;
  conversation_id?: string;
  project_path: string;
  project_name?: string;
  summary?: string;
  files_changed?: string[];
  commit_hash?: string;
  commit_message?: string;
  started_at: string;
  ended_at?: string;
}

export function logWorkSession(
  projectPath: string,
  options?: {
    conversationId?: string;
    projectName?: string;
    summary?: string;
    filesChanged?: string[];
    commitHash?: string;
    commitMessage?: string;
  }
): number {
  const db = getDb();
  const result = db.run(
    `INSERT INTO work_sessions (
      conversation_id, project_path, project_name, summary, files_changed, commit_hash, commit_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      options?.conversationId ?? null,
      projectPath,
      options?.projectName ?? null,
      options?.summary ?? null,
      options?.filesChanged ? JSON.stringify(options.filesChanged) : null,
      options?.commitHash ?? null,
      options?.commitMessage ?? null,
    ]
  );
  return Number(result.lastInsertRowid);
}

export function updateWorkSessionWithCommit(
  id: number,
  commitHash: string,
  commitMessage?: string
): void {
  const db = getDb();
  db.run(
    `UPDATE work_sessions SET commit_hash = ?, commit_message = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [commitHash, commitMessage ?? null, id]
  );
}

export function getRecentWorkSessions(options?: {
  projectPath?: string;
  uncommittedOnly?: boolean;
  limit?: number;
}): WorkSession[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (options?.projectPath) {
    conditions.push("project_path = ?");
    params.push(options.projectPath);
  }
  if (options?.uncommittedOnly) {
    conditions.push("commit_hash IS NULL");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options?.limit ?? 20;

  const rows = db.query(`
    SELECT * FROM work_sessions
    ${where}
    ORDER BY started_at DESC
    LIMIT ${limit}
  `).all(...params) as any[];

  return rows.map((row) => ({
    ...row,
    files_changed: row.files_changed ? JSON.parse(row.files_changed) : undefined,
  }));
}
