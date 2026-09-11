// Entity types that the knowledge graph stores
export type EntityType =
  | 'file'
  | 'function'
  | 'class'
  | 'service'
  | 'library'
  | 'pattern'
  | 'error'
  | 'decision'
  | 'config'
  | 'endpoint'
  | 'test'
  | 'ticket';

// Relation types between entities
export type RelationType =
  | 'uses'
  | 'depends_on'
  | 'modifies'
  | 'tests'
  | 'calls'
  | 'caused_by'
  | 'fixed_by'
  | 'replaces'
  | 'contains'
  | 'implements'
  | 'configures';

export interface Entity {
  id: string;
  type: EntityType;
  name: string;
  workspace: string;
  metadata: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface Relation {
  sourceId: string;
  targetId: string;
  type: RelationType;
  context: string;        // why this relation exists
  conversationId: string;
  timestamp: number;
}

export interface Fact {
  id: string;
  entityId: string;
  key: string;
  value: string;
  confidence: number;     // 0.0 - 1.0
  sourceConversationId: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationMeta {
  id: string;
  workspace: string;
  projectName: string;
  ide: 'vscode' | 'mcp' | 'other';
  title: string;
  summary?: string;
  startedAt: number;
  endedAt?: number;
}

// Raw message — temporary, deleted after extraction
export interface RawMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
}

// Query input for searching the graph
export interface GraphQuery {
  // Direct entity lookup
  entityName?: string;
  entityType?: EntityType;
  // Workspace filter
  workspace?: string;
  // Time range
  since?: number;
  // Traversal depth (default 2)
  depth?: number;
  // Limit results
  limit?: number;
}

// Result from a graph query
export interface GraphResult {
  entities: Entity[];
  relations: Relation[];
  facts: Fact[];
  conversations?: ConversationMeta[];
}

// Extracted knowledge from a conversation
export interface ExtractedKnowledge {
  entities: Omit<Entity, 'id' | 'createdAt' | 'updatedAt'>[];
  relations: Omit<Relation, 'timestamp'>[];
  facts: Omit<Fact, 'id' | 'createdAt' | 'updatedAt'>[];
  /** Maps entity key (type:name) to role: 'modified' or 'referenced' */
  entityRoles: Map<string, 'modified' | 'referenced'>;
  /** Auto-generated conversation summary */
  summary: string;
}

// Code content stored from codebase indexing
export interface CodeContent {
  id: string;
  entityId: string;
  workspace: string;
  filePath: string;
  language: string;
  contentHash: string;
  /** Structured summary: exports, functions, classes, interfaces, imports */
  structure: CodeStructure;
  /** Optional: key source snippets (signatures, type defs) */
  sourceSnippet?: string;
  lineCount: number;
  sizeBytes: number;
  indexedAt: number;
}

export interface CodeStructure {
  exports: string[];
  imports: { name: string; from: string }[];
  functions: FunctionSig[];
  classes: ClassSig[];
  interfaces: string[];
  types: string[];
  constants: string[];
  description?: string;
}

export interface FunctionSig {
  name: string;
  params: string;
  returnType?: string;
  exported: boolean;
  line?: number;
}

export interface ClassSig {
  name: string;
  methods: string[];
  properties: string[];
  exported: boolean;
  extends?: string;
  implements?: string[];
  line?: number;
}

export interface IndexResult {
  filesIndexed: number;
  filesSkipped: number;
  filesUnchanged: number;
  entitiesCreated: number;
  relationsCreated: number;
  errors: string[];
}

// Stored prompt — either auto-captured from conversations or manually saved as template
export interface Prompt {
  id: string;
  content: string;
  type: 'conversation' | 'template';
  title?: string;
  tags?: string[];
  workspace?: string;
  conversationId?: string;
  createdAt: number;
}

// Aggregated prompt usage — one entry per distinct prompt content, ranked by how
// many times it was used within a given time window.
export interface PromptUsage {
  content: string;
  count: number;
  title?: string;
  type: 'conversation' | 'template';
  workspace?: string;
  firstUsed: number;
  lastUsed: number;
  // Number of distinct phrasings merged into this entry when semantic grouping is
  // enabled (1 = only exact-content matches were counted).
  variants?: number;
}
