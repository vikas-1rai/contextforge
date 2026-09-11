import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import {
  Entity,
  EntityType,
  Fact,
  Relation,
  RelationType,
  ConversationMeta,
  GraphQuery,
  GraphResult,
  ExtractedKnowledge,
  CodeContent,
  CodeStructure,
  Prompt,
  PromptUsage,
} from '../models';
import { initializeSchema, getDefaultDbPath, ensureDbDir } from './schema';
import { Embedder } from '../search/embedder';
import { redactSecrets } from '../redaction';

export class MemoryDatabase {
  private db!: Database.Database;
  private dbPath: string;
  private initialized = false;
  private embedder: Embedder;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || getDefaultDbPath();
    this.embedder = new Embedder();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    ensureDbDir(this.dbPath);
    this.db = new Database(this.dbPath);
    initializeSchema(this.db);
    await this.embedder.init();
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (!this.initialized) return;
    try {
      this.db.close();
    } catch { /* safe to ignore */ }
    this.initialized = false;
  }

  get vectorSearchAvailable(): boolean {
    return this.embedder.available;
  }

  // ─── Entity CRUD ──────────────────────────────────────────

  async upsertEntity(entity: Omit<Entity, 'id' | 'createdAt' | 'updatedAt'>): Promise<Entity> {
    this.ensureInit();
    const now = Date.now();

    const existing = this.db.prepare(
      'SELECT id, created_at FROM entities WHERE name = ? AND type = ? AND workspace = ?',
    ).get(entity.name, entity.type, entity.workspace) as { id: string; created_at: number } | undefined;

    if (existing) {
      this.db.prepare(
        'UPDATE entities SET metadata = ?, updated_at = ? WHERE id = ?',
      ).run(JSON.stringify(entity.metadata), now, existing.id);

      // Update FTS index
      this.syncFts(existing.id);

      return { ...entity, id: existing.id, createdAt: existing.created_at, updatedAt: now };
    }

    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO entities (id, type, name, workspace, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, entity.type, entity.name, entity.workspace, JSON.stringify(entity.metadata), now, now);

    // Add to FTS index
    this.syncFts(id);

    return { ...entity, id, createdAt: now, updatedAt: now };
  }

  private syncFts(entityId: string): void {
    const entity = this.db.prepare('SELECT rowid, name FROM entities WHERE id = ?').get(entityId) as { rowid: number; name: string } | undefined;
    if (!entity) return;
    // Remove old FTS entry and re-add
    try {
      this.db.prepare("INSERT INTO entities_fts(entities_fts, rowid, name) VALUES('delete', ?, ?)").run(entity.rowid, entity.name);
    } catch { /* might not exist yet */ }
    this.db.prepare('INSERT INTO entities_fts(rowid, name) VALUES (?, ?)').run(entity.rowid, entity.name);
  }

  private syncFactFts(factId: string): void {
    const fact = this.db.prepare('SELECT rowid, entity_id, key, value FROM facts WHERE id = ?').get(factId) as { rowid: number; entity_id: string; key: string; value: string } | undefined;
    if (!fact) return;
    try {
      this.db.prepare("INSERT INTO facts_fts(facts_fts, rowid, entity_id, key, value) VALUES('delete', ?, ?, ?, ?)").run(fact.rowid, fact.entity_id, fact.key, fact.value);
    } catch { /* might not exist yet */ }
    this.db.prepare('INSERT INTO facts_fts(rowid, entity_id, key, value) VALUES (?, ?, ?, ?)').run(fact.rowid, fact.entity_id, fact.key, fact.value);
  }

  private async syncEntityEmbedding(entityId: string): Promise<void> {
    if (!this.embedder.available) return;
    const entity = this.db.prepare('SELECT rowid, name FROM entities WHERE id = ?').get(entityId) as { rowid: number; name: string } | undefined;
    if (!entity) return;

    // Build text from entity name + all its fact values for richer embedding
    const factRows = this.db.prepare('SELECT key, value FROM facts WHERE entity_id = ?').all(entityId) as { key: string; value: string }[];
    const factText = factRows.map(f => `${f.key}: ${f.value}`).join('. ');
    const text = factText ? `${entity.name}. ${factText}` : entity.name;

    const embedding = await this.embedder.embed(text);
    if (!embedding) return;

    const blob = Embedder.toBlob(embedding);
    const rowid = BigInt(entity.rowid);
    try {
      this.db.prepare('DELETE FROM vec_entities WHERE rowid = ?').run(rowid);
    } catch { /* might not exist */ }
    this.db.prepare('INSERT INTO vec_entities (rowid, entity_embedding) VALUES (?, ?)').run(rowid, blob);
  }

  // ─── Relation CRUD ────────────────────────────────────────

  async addRelation(rel: Omit<Relation, 'timestamp'>): Promise<void> {
    this.ensureInit();
    const now = Date.now();

    const existing = this.db.prepare(
      'SELECT id FROM relations WHERE source_id = ? AND target_id = ? AND type = ?',
    ).get(rel.sourceId, rel.targetId, rel.type) as { id: number } | undefined;

    if (existing) {
      this.db.prepare(
        'UPDATE relations SET context = ?, conversation_id = ?, timestamp = ? WHERE id = ?',
      ).run(rel.context, rel.conversationId, now, existing.id);
      return;
    }

    this.db.prepare(
      'INSERT INTO relations (source_id, target_id, type, context, conversation_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(rel.sourceId, rel.targetId, rel.type, rel.context, rel.conversationId, now);
  }

  // ─── Fact CRUD ────────────────────────────────────────────

  async upsertFact(fact: Omit<Fact, 'id' | 'createdAt' | 'updatedAt'>, entityId: string): Promise<Fact> {
    this.ensureInit();
    const now = Date.now();

    const existing = this.db.prepare(
      'SELECT id, created_at FROM facts WHERE entity_id = ? AND key = ?',
    ).get(entityId, fact.key) as { id: string; created_at: number } | undefined;

    if (existing) {
      this.db.prepare(
        'UPDATE facts SET value = ?, confidence = ?, source_conversation_id = ?, updated_at = ? WHERE id = ?',
      ).run(fact.value, fact.confidence, fact.sourceConversationId, now, existing.id);
      this.syncFactFts(existing.id);
      void this.syncEntityEmbedding(entityId);
      return { ...fact, id: existing.id, entityId, createdAt: existing.created_at, updatedAt: now };
    }

    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO facts (id, entity_id, key, value, confidence, source_conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, entityId, fact.key, fact.value, fact.confidence, fact.sourceConversationId, now, now);
    this.syncFactFts(id);
    void this.syncEntityEmbedding(entityId);
    return { ...fact, id, entityId, createdAt: now, updatedAt: now };
  }

  // ─── Conversation metadata ────────────────────────────────

  async saveConversation(conv: ConversationMeta): Promise<void> {
    this.ensureInit();

    const existing = this.db.prepare('SELECT id FROM conversations WHERE id = ?').get(conv.id);

    if (existing) {
      this.db.prepare(
        'UPDATE conversations SET title = ?, summary = ?, ended_at = ? WHERE id = ?',
      ).run(conv.title, conv.summary ?? '', conv.endedAt ?? 0, conv.id);
    } else {
      this.db.prepare(
        'INSERT INTO conversations (id, workspace, project_name, ide, title, summary, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(conv.id, conv.workspace, conv.projectName, conv.ide, conv.title, conv.summary ?? '', conv.startedAt, conv.endedAt ?? 0);
    }

    // Generate and store summary embedding for vector search
    if (conv.summary && this.embedder.available) {
      const embedding = await this.embedder.embed(conv.summary);
      if (embedding) {
        const blob = Embedder.toBlob(embedding);
        const row = this.db.prepare('SELECT rowid FROM conversations WHERE id = ?').get(conv.id) as { rowid: number };
        if (row) {
          // sqlite-vec requires BigInt for rowid parameters
          const rowid = BigInt(row.rowid);
          // Remove old embedding if exists, then insert new one
          try {
            this.db.prepare('DELETE FROM vec_conversations WHERE rowid = ?').run(rowid);
          } catch { /* might not exist */ }
          this.db.prepare('INSERT INTO vec_conversations (rowid, summary_embedding) VALUES (?, ?)').run(rowid, blob);
        }
      }
    }
  }

  // ─── Graph queries ────────────────────────────────────────

  async query(q: GraphQuery): Promise<GraphResult> {
    this.ensureInit();
    const depth = q.depth ?? 2;
    const limit = q.limit ?? 50;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (q.entityType) {
      conditions.push('e.type = ?');
      params.push(q.entityType);
    }
    if (q.workspace) {
      conditions.push('e.workspace = ?');
      params.push(q.workspace);
    }
    if (q.since) {
      conditions.push('e.updated_at >= ?');
      params.push(q.since);
    }

    const filterClause = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';

    // Collect matching entity IDs from all three search paths, ranked by relevance
    const matchedIds = new Map<string, number>(); // id → score (higher = more relevant)

    if (q.entityName) {
      const nameQuery = q.entityName;

      // Path 1: Entity name LIKE (fast, exact substring)
      const nameLikeRows = this.db.prepare(
        `SELECT id FROM entities e WHERE e.name LIKE ? ${filterClause} ORDER BY e.updated_at DESC LIMIT ?`,
      ).all(`%${nameQuery}%`, ...params, limit) as { id: string }[];
      for (const r of nameLikeRows) matchedIds.set(r.id, (matchedIds.get(r.id) ?? 0) + 10);

      // Path 2: Fact value FTS (searches content of stored facts)
      try {
        const ftsQuery = nameQuery.replace(/['"*]/g, ' ').trim();
        const factFtsRows = this.db.prepare(
          `SELECT DISTINCT f.entity_id
           FROM facts_fts fts
           JOIN facts f ON f.rowid = fts.rowid
           JOIN entities e ON e.id = f.entity_id
           WHERE facts_fts MATCH ? ${filterClause.replace(/e\./g, 'e.')}
           LIMIT ?`,
        ).all(ftsQuery, ...params, limit) as { entity_id: string }[];
        for (const r of factFtsRows) matchedIds.set(r.entity_id, (matchedIds.get(r.entity_id) ?? 0) + 8);
      } catch { /* FTS syntax errors are non-fatal */ }

      // Path 3: Semantic vector search on entity embeddings (name + facts combined)
      if (this.embedder.available) {
        try {
          const queryEmbedding = await this.embedder.embed(nameQuery);
          if (queryEmbedding) {
            const blob = Embedder.toBlob(queryEmbedding);
            const vecRows = this.db.prepare(`
              SELECT e.id, v.distance
              FROM vec_entities v
              JOIN entities e ON e.rowid = v.rowid
              WHERE entity_embedding MATCH ? AND k = ?
              ORDER BY distance
            `).all(blob, Math.min(limit, 20)) as { id: string; distance: number }[];
            for (const r of vecRows) {
              // Convert distance to score: closer = higher score (distance 0 = perfect match)
              const score = Math.max(0, 6 - r.distance * 10);
              matchedIds.set(r.id, (matchedIds.get(r.id) ?? 0) + score);
            }
          }
        } catch { /* vector search non-fatal */ }
      }
    } else {
      // No search term — list entities by filter/recency
      const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
      const rows = this.db.prepare(
        `SELECT id FROM entities e ${whereClause} ORDER BY e.updated_at DESC LIMIT ?`,
      ).all(...params, limit) as { id: string }[];
      for (const r of rows) matchedIds.set(r.id, 1);
    }

    if (matchedIds.size === 0) {
      return { entities: [], relations: [], facts: [], conversations: [] };
    }

    // Load entities sorted by combined relevance score
    const sortedIds = [...matchedIds.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);

    const ph = sortedIds.map(() => '?').join(',');
    const rootRows = this.db.prepare(
      `SELECT id, type, name, workspace, metadata, created_at, updated_at FROM entities WHERE id IN (${ph})`,
    ).all(...sortedIds) as EntityRow[];

    // Re-sort by score order
    const idOrder = new Map(sortedIds.map((id, i) => [id, i]));
    rootRows.sort((a, b) => (idOrder.get(a.id) ?? 999) - (idOrder.get(b.id) ?? 999));

    const entities: Entity[] = rootRows.map(r => this.rowToEntity(r));
    const entityIds = new Set(sortedIds);

    const relations: Relation[] = [];

    // Step 2: Walk relationships (1 hop for performance, repeat for depth)
    if (depth > 0) {
      const visited = new Set(entityIds);
      let frontier = [...entityIds];

      for (let d = 0; d < depth && frontier.length > 0; d++) {
        const placeholders = frontier.map(() => '?').join(',');
        const neighborRows = this.db.prepare(
          `SELECT DISTINCT e.id, e.type, e.name, e.workspace, e.metadata, e.created_at, e.updated_at
           FROM entities e
           JOIN relations r ON (e.id = r.target_id OR e.id = r.source_id)
           WHERE (r.source_id IN (${placeholders}) OR r.target_id IN (${placeholders}))
             AND e.id NOT IN (${[...visited].map(() => '?').join(',')})
           LIMIT ?`,
        ).all(...frontier, ...frontier, ...visited, limit) as EntityRow[];

        const nextFrontier: string[] = [];
        for (const row of neighborRows) {
          if (!visited.has(row.id)) {
            entities.push(this.rowToEntity(row));
            entityIds.add(row.id);
            visited.add(row.id);
            nextFrontier.push(row.id);
          }
        }
        frontier = nextFrontier;
      }

      // Get all relations between found entities
      const allIds = [...entityIds];
      const ph = allIds.map(() => '?').join(',');
      const relRows = this.db.prepare(
        `SELECT source_id, target_id, type, context, conversation_id, timestamp
         FROM relations
         WHERE source_id IN (${ph}) AND target_id IN (${ph})`,
      ).all(...allIds, ...allIds) as RelationRow[];

      for (const row of relRows) {
        relations.push({
          sourceId: row.source_id,
          targetId: row.target_id,
          type: row.type as RelationType,
          context: row.context || '',
          conversationId: row.conversation_id || '',
          timestamp: row.timestamp,
        });
      }
    }

    // Step 3: Get facts for all entities
    const facts: Fact[] = [];
    for (const eid of entityIds) {
      const factRows = this.db.prepare(
        'SELECT id, entity_id, key, value, confidence, source_conversation_id, created_at, updated_at FROM facts WHERE entity_id = ?',
      ).all(eid) as FactRow[];

      for (const row of factRows) {
        facts.push({
          id: row.id,
          entityId: row.entity_id,
          key: row.key,
          value: row.value,
          confidence: row.confidence,
          sourceConversationId: row.source_conversation_id || '',
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      }
    }

    // Step 4: Get conversation provenance
    const conversations = await this.getConversationProvenance(entityIds);

    return { entities, relations, facts, conversations };
  }

  async getWorkspaceContext(workspace: string, limit = 100): Promise<GraphResult> {
    return this.query({ workspace, limit, depth: 2 });
  }

  async getKnownWorkspaces(): Promise<string[]> {
    this.ensureInit();
    const rows = this.db.prepare('SELECT DISTINCT workspace FROM entities').all() as { workspace: string }[];
    return rows.map(r => r.workspace).filter(Boolean);
  }

  /**
   * Semantic search on conversation summaries using vector similarity.
   * Falls back to FTS if embedder is not available.
   */
  async searchBySummary(queryText: string, limit = 5): Promise<ConversationMeta[]> {
    this.ensureInit();

    // Try vector search first
    if (this.embedder.available) {
      const queryEmbedding = await this.embedder.embed(queryText);
      if (queryEmbedding) {
        const blob = Embedder.toBlob(queryEmbedding);
        const rows = this.db.prepare(`
          SELECT c.id, c.workspace, c.project_name, c.ide, c.title, c.summary, c.started_at, c.ended_at, v.distance
          FROM vec_conversations v
          JOIN conversations c ON c.rowid = v.rowid
          WHERE summary_embedding MATCH ? AND k = ?
          ORDER BY distance
        `).all(blob, limit) as (ConversationRow & { distance: number })[];

        return rows.map(r => this.rowToConversation(r));
      }
    }

    // Fallback: LIKE search on summary text
    const rows = this.db.prepare(
      'SELECT id, workspace, project_name, ide, title, summary, started_at, ended_at FROM conversations WHERE summary LIKE ? ORDER BY started_at DESC LIMIT ?',
    ).all(`%${queryText}%`, limit) as ConversationRow[];

    return rows.map(r => this.rowToConversation(r));
  }

  /**
   * Get conversation provenance for a set of entities.
   */
  async getConversationProvenance(entityIds: Set<string>): Promise<ConversationMeta[]> {
    this.ensureInit();
    if (entityIds.size === 0) return [];

    const allIds = [...entityIds];
    const ph = allIds.map(() => '?').join(',');

    const rows = this.db.prepare(`
      SELECT DISTINCT c.id, c.workspace, c.project_name, c.ide, c.title, c.summary, c.started_at, c.ended_at
      FROM conversations c
      JOIN mentioned_in m ON m.conversation_id = c.id
      WHERE m.entity_id IN (${ph})
      ORDER BY c.started_at DESC
      LIMIT 10
    `).all(...allIds) as ConversationRow[];

    return rows.map(r => this.rowToConversation(r));
  }

  async ingestKnowledge(knowledge: ExtractedKnowledge, conversationId: string): Promise<void> {
    this.ensureInit();

    // Use a transaction for atomicity and performance
    const ingestTxn = this.db.transaction(() => {
      const entityIdMap = new Map<string, string>();

      for (const e of knowledge.entities) {
        // upsertEntity is sync internally (though typed async for interface compat)
        const id = randomUUID();
        const now = Date.now();
        const existing = this.db.prepare(
          'SELECT id, created_at FROM entities WHERE name = ? AND type = ? AND workspace = ?',
        ).get(e.name, e.type, e.workspace) as { id: string; created_at: number } | undefined;

        let savedId: string;
        if (existing) {
          this.db.prepare('UPDATE entities SET metadata = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(e.metadata), now, existing.id);
          savedId = existing.id;
        } else {
          this.db.prepare(
            'INSERT INTO entities (id, type, name, workspace, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ).run(id, e.type, e.name, e.workspace, JSON.stringify(e.metadata), now, now);
          savedId = id;
        }

        const entityKey = e.type + ':' + e.name;
        entityIdMap.set(entityKey, savedId);

        // MENTIONED_IN with role
        const role = knowledge.entityRoles?.get(entityKey) || 'subject';
        this.db.prepare(
          'INSERT INTO mentioned_in (entity_id, conversation_id, role) VALUES (?, ?, ?)',
        ).run(savedId, conversationId, role);
      }

      // Relations
      for (const r of knowledge.relations) {
        const sourceId = entityIdMap.get(r.sourceId) || r.sourceId;
        const targetId = entityIdMap.get(r.targetId) || r.targetId;
        const now = Date.now();

        const existing = this.db.prepare(
          'SELECT id FROM relations WHERE source_id = ? AND target_id = ? AND type = ?',
        ).get(sourceId, targetId, r.type) as { id: number } | undefined;

        if (existing) {
          this.db.prepare('UPDATE relations SET context = ?, conversation_id = ?, timestamp = ? WHERE id = ?')
            .run(r.context, r.conversationId, now, existing.id);
        } else {
          this.db.prepare(
            'INSERT INTO relations (source_id, target_id, type, context, conversation_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(sourceId, targetId, r.type, r.context, r.conversationId, now);
        }
      }

      // Facts
      for (const f of knowledge.facts) {
        const entityId = entityIdMap.get(f.entityId) || f.entityId;
        const now = Date.now();

        const existing = this.db.prepare(
          'SELECT id, created_at FROM facts WHERE entity_id = ? AND key = ?',
        ).get(entityId, f.key) as { id: string; created_at: number } | undefined;

        if (existing) {
          this.db.prepare('UPDATE facts SET value = ?, confidence = ?, source_conversation_id = ?, updated_at = ? WHERE id = ?')
            .run(f.value, f.confidence, f.sourceConversationId, now, existing.id);
        } else {
          const factId = randomUUID();
          this.db.prepare(
            'INSERT INTO facts (id, entity_id, key, value, confidence, source_conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(factId, entityId, f.key, f.value, f.confidence, f.sourceConversationId, now, now);
        }
      }
    });

    ingestTxn();
  }

  // ─── Code Content (Codebase Indexing) ─────────────────────

  /**
   * Upsert a code content entry. If the content hash hasn't changed, skip the update.
   * Returns true if the entry was inserted/updated, false if unchanged.
   */
  async upsertCodeContent(code: Omit<CodeContent, 'id' | 'indexedAt'>): Promise<boolean> {
    this.ensureInit();

    const existing = this.db.prepare(
      'SELECT id, content_hash FROM code_content WHERE entity_id = ? AND file_path = ?',
    ).get(code.entityId, code.filePath) as { id: string; content_hash: string } | undefined;

    if (existing && existing.content_hash === code.contentHash) {
      return false; // No changes
    }

    const now = Date.now();
    const structureJson = JSON.stringify(code.structure);

    if (existing) {
      this.db.prepare(
        `UPDATE code_content SET content_hash = ?, structure = ?, source_snippet = ?,
         language = ?, line_count = ?, size_bytes = ?, indexed_at = ? WHERE id = ?`,
      ).run(code.contentHash, structureJson, code.sourceSnippet || null,
        code.language, code.lineCount, code.sizeBytes, now, existing.id);

      // Update FTS
      try {
        const row = this.db.prepare('SELECT rowid FROM code_content WHERE id = ?').get(existing.id) as { rowid: number };
        this.db.prepare("INSERT INTO code_fts(code_fts, rowid, file_path, structure) VALUES('delete', ?, ?, ?)")
          .run(row.rowid, code.filePath, structureJson);
        this.db.prepare('INSERT INTO code_fts(rowid, file_path, structure) VALUES (?, ?, ?)')
          .run(row.rowid, code.filePath, structureJson);
      } catch { /* FTS sync non-critical */ }

      return true;
    }

    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO code_content (id, entity_id, workspace, file_path, language, content_hash,
       structure, source_snippet, line_count, size_bytes, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, code.entityId, code.workspace, code.filePath, code.language,
      code.contentHash, structureJson, code.sourceSnippet || null,
      code.lineCount, code.sizeBytes, now);

    // Add to FTS
    try {
      const row = this.db.prepare('SELECT rowid FROM code_content WHERE id = ?').get(id) as { rowid: number };
      this.db.prepare('INSERT INTO code_fts(rowid, file_path, structure) VALUES (?, ?, ?)')
        .run(row.rowid, code.filePath, structureJson);
    } catch { /* FTS sync non-critical */ }

    return true;
  }

  /**
   * Get code content for a specific file path within a workspace.
   */
  async getCodeContent(workspace: string, filePath: string): Promise<CodeContent | null> {
    this.ensureInit();
    const row = this.db.prepare(
      'SELECT * FROM code_content WHERE workspace = ? AND file_path = ?',
    ).get(workspace, filePath) as CodeContentRow | undefined;

    if (!row) return null;
    return this.rowToCodeContent(row);
  }

  /**
   * Get all indexed code content for a workspace, optionally filtered by path prefix.
   */
  async getCodeContext(workspace: string, options?: {
    pathPrefix?: string;
    language?: string;
    limit?: number;
    structureOnly?: boolean;
  }): Promise<CodeContent[]> {
    this.ensureInit();

    const conditions = ['workspace = ?'];
    const params: unknown[] = [workspace];

    if (options?.pathPrefix) {
      conditions.push('file_path LIKE ?');
      params.push(options.pathPrefix + '%');
    }
    if (options?.language) {
      conditions.push('language = ?');
      params.push(options.language);
    }

    const limit = options?.limit ?? 500;
    const whereClause = conditions.join(' AND ');

    const rows = this.db.prepare(
      `SELECT * FROM code_content WHERE ${whereClause} ORDER BY file_path ASC LIMIT ?`,
    ).all(...params, limit) as CodeContentRow[];

    return rows.map(r => this.rowToCodeContent(r));
  }

  /**
   * Search code content by FTS query (function names, class names, file paths).
   */
  async searchCode(query: string, workspace?: string, limit = 20): Promise<CodeContent[]> {
    this.ensureInit();

    // FTS5 search
    try {
      let sql: string;
      const params: unknown[] = [];

      if (workspace) {
        sql = `SELECT c.* FROM code_content c
               JOIN code_fts f ON c.rowid = f.rowid
               WHERE code_fts MATCH ? AND c.workspace = ?
               ORDER BY rank LIMIT ?`;
        params.push(query, workspace, limit);
      } else {
        sql = `SELECT c.* FROM code_content c
               JOIN code_fts f ON c.rowid = f.rowid
               WHERE code_fts MATCH ?
               ORDER BY rank LIMIT ?`;
        params.push(query, limit);
      }

      const rows = this.db.prepare(sql).all(...params) as CodeContentRow[];
      return rows.map(r => this.rowToCodeContent(r));
    } catch {
      // Fallback to LIKE
      const conditions = ['(file_path LIKE ? OR structure LIKE ?)'];
      const params: unknown[] = [`%${query}%`, `%${query}%`];
      if (workspace) {
        conditions.push('workspace = ?');
        params.push(workspace);
      }
      const rows = this.db.prepare(
        `SELECT * FROM code_content WHERE ${conditions.join(' AND ')} ORDER BY file_path ASC LIMIT ?`,
      ).all(...params, limit) as CodeContentRow[];
      return rows.map(r => this.rowToCodeContent(r));
    }
  }

  /**
   * Get content hash for a file to determine if re-indexing is needed.
   */
  getContentHash(workspace: string, filePath: string): string | null {
    this.ensureInit();
    const row = this.db.prepare(
      'SELECT content_hash FROM code_content WHERE workspace = ? AND file_path = ?',
    ).get(workspace, filePath) as { content_hash: string } | undefined;
    return row?.content_hash ?? null;
  }

  /**
   * Remove indexed code for files that no longer exist.
   */
  async pruneDeletedFiles(workspace: string, existingPaths: Set<string>): Promise<number> {
    this.ensureInit();
    const rows = this.db.prepare(
      'SELECT id, file_path, entity_id FROM code_content WHERE workspace = ?',
    ).all(workspace) as { id: string; file_path: string; entity_id: string }[];

    let pruned = 0;
    const pruneTxn = this.db.transaction(() => {
      for (const row of rows) {
        if (!existingPaths.has(row.file_path)) {
          this.db.prepare('DELETE FROM code_content WHERE id = ?').run(row.id);
          pruned++;
        }
      }
    });
    pruneTxn();
    return pruned;
  }

  private rowToCodeContent(row: CodeContentRow): CodeContent {
    let structure: CodeStructure;
    try {
      structure = JSON.parse(row.structure);
    } catch {
      structure = { exports: [], imports: [], functions: [], classes: [], interfaces: [], types: [], constants: [] };
    }
    return {
      id: row.id,
      entityId: row.entity_id,
      workspace: row.workspace,
      filePath: row.file_path,
      language: row.language || '',
      contentHash: row.content_hash,
      structure,
      sourceSnippet: row.source_snippet || undefined,
      lineCount: row.line_count || 0,
      sizeBytes: row.size_bytes || 0,
      indexedAt: row.indexed_at,
    };
  }

  // ─── Prompts ───────────────────────────────────────────────

  async savePrompt(prompt: Omit<Prompt, 'id' | 'createdAt'>): Promise<Prompt> {
    this.ensureInit();
    const id = randomUUID();
    const now = Date.now();
    const tags = prompt.tags?.join(',') || null;

    // Mask secrets (passwords, tokens, keys) BEFORE storing or embedding, so they
    // never persist in plaintext locally or reach the centralized store.
    const content = redactSecrets(prompt.content);
    const title = prompt.title ? redactSecrets(prompt.title) : null;

    // Compute a semantic embedding so identical/similar prompts can be grouped.
    let embeddingBlob: Buffer | null = null;
    if (this.embedder.available) {
      const embedding = await this.embedder.embed(content);
      if (embedding) embeddingBlob = Embedder.toBlob(embedding);
    }

    this.db.prepare(
      'INSERT INTO prompts (id, content, type, title, tags, workspace, conversation_id, created_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, content, prompt.type, title, tags, prompt.workspace || null, prompt.conversationId || null, now, embeddingBlob);

    // Sync FTS
    try {
      const row = this.db.prepare('SELECT rowid FROM prompts WHERE id = ?').get(id) as { rowid: number };
      this.db.prepare('INSERT INTO prompts_fts(rowid, content, title, tags) VALUES (?, ?, ?, ?)')
        .run(row.rowid, content, title || '', tags || '');
    } catch { /* FTS sync non-critical */ }

    return { ...prompt, id, content, title: title || undefined, tags: prompt.tags, createdAt: now };
  }

  async searchPrompts(query: string, options?: {
    type?: 'conversation' | 'template';
    workspace?: string;
    limit?: number;
  }): Promise<Prompt[]> {
    this.ensureInit();
    const limit = options?.limit ?? 50;

    // Try FTS5 first
    try {
      const conditions = ['prompts_fts MATCH ?'];
      const params: unknown[] = [query];

      let sql = `SELECT p.* FROM prompts p JOIN prompts_fts f ON p.rowid = f.rowid WHERE ${conditions.join(' AND ')}`;

      if (options?.type) {
        sql += ' AND p.type = ?';
        params.push(options.type);
      }
      if (options?.workspace) {
        sql += ' AND p.workspace = ?';
        params.push(options.workspace);
      }

      sql += ' ORDER BY rank LIMIT ?';
      params.push(limit);

      const rows = this.db.prepare(sql).all(...params) as PromptRow[];
      return rows.map(r => this.rowToPrompt(r));
    } catch {
      // Fallback to LIKE
      const conditions = ['(content LIKE ? OR title LIKE ? OR tags LIKE ?)'];
      const params: unknown[] = [`%${query}%`, `%${query}%`, `%${query}%`];

      if (options?.type) {
        conditions.push('type = ?');
        params.push(options.type);
      }
      if (options?.workspace) {
        conditions.push('workspace = ?');
        params.push(options.workspace);
      }

      const rows = this.db.prepare(
        `SELECT * FROM prompts WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      ).all(...params, limit) as PromptRow[];
      return rows.map(r => this.rowToPrompt(r));
    }
  }

  async listPrompts(options?: {
    type?: 'conversation' | 'template';
    workspace?: string;
    since?: number;
    until?: number;
    limit?: number;
  }): Promise<Prompt[]> {
    this.ensureInit();
    const limit = options?.limit ?? 50;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.type) {
      conditions.push('type = ?');
      params.push(options.type);
    }
    if (options?.workspace) {
      conditions.push('workspace = ?');
      params.push(options.workspace);
    }
    if (options?.since) {
      conditions.push('created_at >= ?');
      params.push(options.since);
    }
    if (options?.until) {
      conditions.push('created_at <= ?');
      params.push(options.until);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = this.db.prepare(
      `SELECT * FROM prompts ${whereClause} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params, limit) as PromptRow[];

    return rows.map(r => this.rowToPrompt(r));
  }

  async deletePrompt(id: string): Promise<boolean> {
    this.ensureInit();
    const result = this.db.prepare('DELETE FROM prompts WHERE id = ?').run(id);
    return result.changes > 0;
  }

  async getPromptStats(): Promise<{ total: number; templates: number; conversation: number }> {
    this.ensureInit();
    const total = (this.db.prepare('SELECT COUNT(*) AS cnt FROM prompts').get() as { cnt: number }).cnt;
    const templates = (this.db.prepare("SELECT COUNT(*) AS cnt FROM prompts WHERE type = 'template'").get() as { cnt: number }).cnt;
    return { total, templates, conversation: total - templates };
  }

  /**
   * Rank prompts by usage frequency (most-used first) within an optional time window.
   * Distinct prompt content is grouped and counted, so identical prompts issued
   * multiple times are reported as a single entry with a usage count.
   *
   * When `semantic` is enabled, semantically similar prompts (cosine similarity of
   * their embeddings >= `similarityThreshold`) are merged into a single ranked
   * entry, and their usage counts are summed. The most-used phrasing becomes the
   * representative content.
   */
  async getTopPrompts(options?: {
    type?: 'conversation' | 'template';
    workspace?: string;
    since?: number;
    until?: number;
    limit?: number;
    semantic?: boolean;
    similarityThreshold?: number;
  }): Promise<PromptUsage[]> {
    this.ensureInit();
    const limit = options?.limit ?? 20;
    const semantic = options?.semantic ?? false;
    const threshold = options?.similarityThreshold ?? 0.85;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.type) {
      conditions.push('type = ?');
      params.push(options.type);
    }
    if (options?.workspace) {
      conditions.push('workspace = ?');
      params.push(options.workspace);
    }
    if (options?.since) {
      conditions.push('created_at >= ?');
      params.push(options.since);
    }
    if (options?.until) {
      conditions.push('created_at <= ?');
      params.push(options.until);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // Exact-content grouping happens in SQL. When semantic grouping is requested we
    // pull all groups (no LIMIT) so clustering can merge them before re-ranking.
    const limitClause = semantic ? '' : 'LIMIT ?';
    const queryParams = semantic ? params : [...params, limit];

    const rows = this.db.prepare(
      `SELECT content,
              COUNT(*) AS usage_count,
              MIN(created_at) AS first_used,
              MAX(created_at) AS last_used,
              MAX(title) AS title,
              MAX(type) AS type,
              MAX(workspace) AS workspace,
              MAX(embedding) AS embedding
       FROM prompts
       ${whereClause}
       GROUP BY content
       ORDER BY usage_count DESC, last_used DESC
       ${limitClause}`,
    ).all(...queryParams) as Array<{
      content: string;
      usage_count: number;
      first_used: number;
      last_used: number;
      title: string | null;
      type: string;
      workspace: string | null;
      embedding: Buffer | null;
    }>;

    if (!semantic) {
      return rows.map(r => ({
        content: r.content,
        count: r.usage_count,
        title: r.title || undefined,
        type: r.type as PromptUsage['type'],
        workspace: r.workspace || undefined,
        firstUsed: r.first_used,
        lastUsed: r.last_used,
      }));
    }

    // Greedy single-pass clustering. Rows are already ordered by usage_count DESC,
    // so the first member of each cluster is its most-used representative.
    interface Cluster {
      rep: (typeof rows)[number];
      embedding: Float32Array | null;
      count: number;
      firstUsed: number;
      lastUsed: number;
      variants: number;
    }
    const clusters: Cluster[] = [];

    for (const row of rows) {
      const emb = row.embedding ? Embedder.fromBlob(row.embedding) : null;

      let target: Cluster | undefined;
      if (emb) {
        let bestSim = threshold;
        for (const c of clusters) {
          if (!c.embedding) continue;
          const sim = Embedder.cosineSimilarity(emb, c.embedding);
          if (sim >= bestSim) {
            bestSim = sim;
            target = c;
          }
        }
      }

      if (target) {
        target.count += row.usage_count;
        target.firstUsed = Math.min(target.firstUsed, row.first_used);
        target.lastUsed = Math.max(target.lastUsed, row.last_used);
        target.variants += 1;
      } else {
        clusters.push({
          rep: row,
          embedding: emb,
          count: row.usage_count,
          firstUsed: row.first_used,
          lastUsed: row.last_used,
          variants: 1,
        });
      }
    }

    clusters.sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed);

    return clusters.slice(0, limit).map(c => ({
      content: c.rep.content,
      count: c.count,
      title: c.rep.title || undefined,
      type: c.rep.type as PromptUsage['type'],
      workspace: c.rep.workspace || undefined,
      firstUsed: c.firstUsed,
      lastUsed: c.lastUsed,
      variants: c.variants,
    }));
  }

  private rowToPrompt(row: PromptRow): Prompt {
    return {
      id: row.id,
      content: row.content,
      type: row.type as Prompt['type'],
      title: row.title || undefined,
      tags: row.tags ? row.tags.split(',').map(t => t.trim()) : undefined,
      workspace: row.workspace || undefined,
      conversationId: row.conversation_id || undefined,
      createdAt: row.created_at,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error('Database not initialized. Call init() first.');
    }
  }

  private rowToEntity(row: EntityRow): Entity {
    return {
      id: row.id,
      type: row.type as EntityType,
      name: row.name,
      workspace: row.workspace,
      metadata: this.parseMetadata(row.metadata),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToConversation(row: ConversationRow): ConversationMeta {
    return {
      id: row.id,
      workspace: row.workspace,
      projectName: row.project_name || '',
      ide: (row.ide || 'mcp') as ConversationMeta['ide'],
      title: row.title || '',
      summary: row.summary || undefined,
      startedAt: row.started_at,
      endedAt: row.ended_at || undefined,
    };
  }

  private parseMetadata(raw: string): Record<string, string> {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  // ─── Memory management ───────────────────────────────────

  async getMemoryStatus(): Promise<{
    dbPath: string;
    totalEntities: number;
    totalFacts: number;
    totalRelations: number;
    workspaces: Array<{
      workspace: string;
      entityCount: number;
      factCount: number;
      oldestEntity: number | null;
      newestEntity: number | null;
    }>;
  }> {
    this.ensureInit();

    const entityStats = this.db.prepare(
      'SELECT workspace, COUNT(*) AS cnt, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM entities GROUP BY workspace',
    ).all() as { workspace: string; cnt: number; oldest: number; newest: number }[];

    let totalEntities = 0;
    const workspaces = entityStats.map(r => {
      totalEntities += r.cnt;
      return {
        workspace: r.workspace,
        entityCount: r.cnt,
        factCount: 0,
        oldestEntity: r.oldest,
        newestEntity: r.newest,
      };
    });

    // Facts per workspace
    const factStats = this.db.prepare(
      'SELECT e.workspace, COUNT(f.id) AS cnt FROM facts f JOIN entities e ON f.entity_id = e.id GROUP BY e.workspace',
    ).all() as { workspace: string; cnt: number }[];

    let totalFacts = 0;
    for (const r of factStats) {
      totalFacts += r.cnt;
      const ws = workspaces.find(w => w.workspace === r.workspace);
      if (ws) ws.factCount = r.cnt;
    }

    const relRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM relations').get() as { cnt: number };
    const totalRelations = relRow.cnt;

    return { dbPath: this.dbPath, totalEntities, totalFacts, totalRelations, workspaces };
  }

  async cleanupByTime(cutoffTimestamp: number, workspace?: string): Promise<{ entities: number; facts: number; relations: number }> {
    this.ensureInit();

    const params: unknown[] = [cutoffTimestamp];
    let wsClause = '';
    if (workspace) {
      wsClause = ' AND workspace = ?';
      params.push(workspace);
    }

    // Get entity IDs to delete
    const entityRows = this.db.prepare(
      `SELECT id FROM entities WHERE created_at >= ?${wsClause}`,
    ).all(...params) as { id: string }[];
    const entityIds = entityRows.map(r => r.id);

    if (entityIds.length === 0) {
      return { entities: 0, facts: 0, relations: 0 };
    }

    const ph = entityIds.map(() => '?').join(',');

    // Count before deleting
    const factCount = (this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM facts WHERE entity_id IN (${ph})`,
    ).get(...entityIds) as { cnt: number }).cnt;

    const relCount = (this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM relations WHERE source_id IN (${ph}) OR target_id IN (${ph})`,
    ).get(...entityIds, ...entityIds) as { cnt: number }).cnt;

    // Delete in order (CASCADE handles facts, but explicit for relations)
    const deleteTxn = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM facts WHERE entity_id IN (${ph})`).run(...entityIds);
      this.db.prepare(`DELETE FROM relations WHERE source_id IN (${ph}) OR target_id IN (${ph})`).run(...entityIds, ...entityIds);
      this.db.prepare(`DELETE FROM mentioned_in WHERE entity_id IN (${ph})`).run(...entityIds);
      this.db.prepare(`DELETE FROM entities WHERE id IN (${ph})`).run(...entityIds);
    });
    deleteTxn();

    return { entities: entityIds.length, facts: factCount, relations: relCount };
  }

  async forgetWorkspace(workspace: string): Promise<{ entities: number; facts: number; relations: number; conversations: number }> {
    this.ensureInit();

    const entityRows = this.db.prepare('SELECT id FROM entities WHERE workspace = ?').all(workspace) as { id: string }[];
    const entityIds = entityRows.map(r => r.id);

    let deletedFacts = 0;
    let deletedRelations = 0;

    const deleteTxn = this.db.transaction(() => {
      if (entityIds.length > 0) {
        const ph = entityIds.map(() => '?').join(',');
        deletedFacts = (this.db.prepare(`SELECT COUNT(*) AS cnt FROM facts WHERE entity_id IN (${ph})`).get(...entityIds) as { cnt: number }).cnt;
        deletedRelations = (this.db.prepare(`SELECT COUNT(*) AS cnt FROM relations WHERE source_id IN (${ph}) OR target_id IN (${ph})`).get(...entityIds, ...entityIds) as { cnt: number }).cnt;

        this.db.prepare(`DELETE FROM facts WHERE entity_id IN (${ph})`).run(...entityIds);
        this.db.prepare(`DELETE FROM relations WHERE source_id IN (${ph}) OR target_id IN (${ph})`).run(...entityIds, ...entityIds);
        this.db.prepare(`DELETE FROM mentioned_in WHERE entity_id IN (${ph})`).run(...entityIds);
        this.db.prepare(`DELETE FROM entities WHERE id IN (${ph})`).run(...entityIds);
      }
    });
    deleteTxn();

    // Delete conversations
    const convCount = (this.db.prepare('SELECT COUNT(*) AS cnt FROM conversations WHERE workspace = ?').get(workspace) as { cnt: number }).cnt;
    this.db.prepare('DELETE FROM conversations WHERE workspace = ?').run(workspace);

    return { entities: entityIds.length, facts: deletedFacts, relations: deletedRelations, conversations: convCount };
  }
}

// ─── Row types ──────────────────────────────────────────────

interface EntityRow {
  id: string;
  type: string;
  name: string;
  workspace: string;
  metadata: string;
  created_at: number;
  updated_at: number;
}

interface RelationRow {
  source_id: string;
  target_id: string;
  type: string;
  context: string;
  conversation_id: string;
  timestamp: number;
}

interface FactRow {
  id: string;
  entity_id: string;
  key: string;
  value: string;
  confidence: number;
  source_conversation_id: string;
  created_at: number;
  updated_at: number;
}

interface ConversationRow {
  id: string;
  workspace: string;
  project_name: string;
  ide: string;
  title: string;
  summary: string;
  started_at: number;
  ended_at: number;
}

interface CodeContentRow {
  id: string;
  entity_id: string;
  workspace: string;
  file_path: string;
  language: string;
  content_hash: string;
  structure: string;
  source_snippet: string | null;
  line_count: number;
  size_bytes: number;
  indexed_at: number;
}

interface PromptRow {
  id: string;
  content: string;
  type: string;
  title: string | null;
  tags: string | null;
  workspace: string | null;
  conversation_id: string | null;
  created_at: number;
}
