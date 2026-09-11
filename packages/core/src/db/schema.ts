import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as path from 'path';
import * as fs from 'fs';

/** Embedding vector dimension for all-MiniLM-L6-v2 */
export const EMBEDDING_DIM = 384;
const DEFAULT_DB_FILENAME = 'contextforge.db';
const LEGACY_DB_FILENAME = 'memory.db';

/**
 * Initializes the SQLite database with the contextforge schema.
 * All tables and indexes are created if they don't exist.
 * Enables WAL mode for concurrent access from multiple IDE sessions.
 */
export function initializeSchema(db: Database.Database): void {
  // Enable WAL mode for concurrent access
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Load sqlite-vec extension for vector search
  sqliteVec.load(db);

  // --- Node tables ---

  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      workspace TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      source_conversation_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      project_name TEXT,
      ide TEXT,
      title TEXT,
      summary TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    )
  `);

  // --- Relationship tables ---

  db.exec(`
    CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      type TEXT NOT NULL,
      context TEXT,
      conversation_id TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (source_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES entities(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mentioned_in (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      role TEXT DEFAULT 'subject',
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `);

  // --- Indexes ---

  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_workspace ON entities(workspace)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_updated ON entities(updated_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_name_type_ws ON entities(name, type, workspace)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_entity_key ON facts(entity_id, key)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(source_id, target_id, type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mentioned_entity ON mentioned_in(entity_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mentioned_conv ON mentioned_in(conversation_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace)`);

  // --- FTS5 for entity name search ---

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
      name,
      content=entities,
      content_rowid=rowid
    )
  `);

  // --- FTS5 for fact value search ---

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      entity_id UNINDEXED,
      key,
      value,
      content=facts,
      content_rowid=rowid
    )
  `);

  // --- Vector table for entity semantic search (name + facts combined) ---

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_entities USING vec0(
      entity_embedding float[${EMBEDDING_DIM}]
    )
  `);

  // --- Vector table for conversation summary embeddings ---

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_conversations USING vec0(
      summary_embedding float[${EMBEDDING_DIM}]
    )
  `);

  // --- Code content storage for codebase indexing ---

  db.exec(`
    CREATE TABLE IF NOT EXISTS code_content (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      workspace TEXT NOT NULL,
      file_path TEXT NOT NULL,
      language TEXT,
      content_hash TEXT NOT NULL,
      structure TEXT NOT NULL,
      source_snippet TEXT,
      line_count INTEGER,
      size_bytes INTEGER,
      indexed_at INTEGER NOT NULL,
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_code_workspace ON code_content(workspace)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_code_filepath ON code_content(file_path)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_code_hash ON code_content(content_hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_code_entity ON code_content(entity_id)`);

  // FTS5 for code structure search (function names, class names, exports)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(
      file_path,
      structure,
      content=code_content,
      content_rowid=rowid
    )
  `);

  // --- Prompts storage ---

  db.exec(`
    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'conversation',
      title TEXT,
      tags TEXT,
      workspace TEXT,
      conversation_id TEXT,
      created_at INTEGER NOT NULL,
      embedding BLOB
    )
  `);

  // Migration: add embedding column to prompts tables created before semantic
  // grouping was introduced.
  const promptCols = db.prepare(`PRAGMA table_info(prompts)`).all() as Array<{ name: string }>;
  if (!promptCols.some(c => c.name === 'embedding')) {
    db.exec(`ALTER TABLE prompts ADD COLUMN embedding BLOB`);
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_type ON prompts(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_workspace ON prompts(workspace)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_created ON prompts(created_at)`);

  // FTS5 for prompt search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(
      content,
      title,
      tags,
      content=prompts,
      content_rowid=rowid
    )
  `);

  // --- Backfill facts_fts for existing facts not yet indexed ---
  // Uses a migration marker table to avoid re-running on every startup.
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)`);
  const factsFtsBackfillDone = db.prepare(`SELECT name FROM _migrations WHERE name = 'facts_fts_backfill'`).get();
  if (!factsFtsBackfillDone) {
    const existingFacts = db.prepare(`SELECT rowid, entity_id, key, value FROM facts`).all() as { rowid: number; entity_id: string; key: string; value: string }[];
    for (const f of existingFacts) {
      try {
        db.prepare(`INSERT INTO facts_fts(rowid, entity_id, key, value) VALUES (?, ?, ?, ?)`).run(f.rowid, f.entity_id, f.key, f.value);
      } catch { /* already indexed */ }
    }
    db.prepare(`INSERT INTO _migrations (name) VALUES ('facts_fts_backfill')`).run();
  }
}

/**
 * Returns the default database path: ~/.contextforge/contextforge.db
 */
export function getDefaultDbPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || require('os').homedir();
  return path.join(home, '.contextforge', DEFAULT_DB_FILENAME);
}

/**
 * Ensures the parent directory for the database file exists.
 */
export function ensureDbDir(dbPath: string): void {
  const dbDir = path.dirname(dbPath);
  fs.mkdirSync(dbDir, { recursive: true });

  // Migrate legacy default filename if it exists and the new filename does not.
  if (path.basename(dbPath) !== DEFAULT_DB_FILENAME) {
    return;
  }

  const legacyDbPath = path.join(dbDir, LEGACY_DB_FILENAME);
  if (!fs.existsSync(dbPath) && fs.existsSync(legacyDbPath)) {
    fs.renameSync(legacyDbPath, dbPath);

    const legacyWal = `${legacyDbPath}-wal`;
    const legacyShm = `${legacyDbPath}-shm`;
    const newWal = `${dbPath}-wal`;
    const newShm = `${dbPath}-shm`;

    if (fs.existsSync(legacyWal)) {
      fs.renameSync(legacyWal, newWal);
    }
    if (fs.existsSync(legacyShm)) {
      fs.renameSync(legacyShm, newShm);
    }
  }
}
