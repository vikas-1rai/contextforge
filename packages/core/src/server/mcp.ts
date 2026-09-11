#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MemoryDatabase } from '../db';
import { Extractor } from '../extraction';
import { CodebaseIndexer } from '../indexer';
import { RawMessage, GraphQuery, ExtractedKnowledge } from '../models';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const server = new Server(
  { name: 'contextforge', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {} } },
);

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

const dbPath = process.env.CONTEXTFORGE_DB_PATH
  ? expandTilde(process.env.CONTEXTFORGE_DB_PATH)
  : undefined;
const db = new MemoryDatabase(dbPath);
const DEFAULT_CONTEXT_LIMIT = parseInt(process.env.CONTEXTFORGE_CONTEXT_LIMIT || '500', 10);

// In-flight conversations buffered in memory
const pendingMessages = new Map<string, RawMessage[]>();

// ─── Tool definitions ───────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search_memory',
      description:
        'Search the knowledge graph for entities (files, functions, libraries, errors, decisions, patterns) and past conversations by semantic similarity. Use this to recall past work, decisions, and context from previous conversations across all workspaces.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Entity name or partial name to search for (e.g. "auth.ts", "JWT", "LoginService"). Also searches conversation summaries semantically.' },
          type: { type: 'string', description: 'Filter by entity type', enum: ['file', 'function', 'class', 'service', 'library', 'pattern', 'error', 'decision', 'config', 'endpoint', 'test', 'ticket'] },
          workspace: { type: 'string', description: 'Filter to a specific workspace path' },
          depth: { type: 'number', description: 'Graph traversal depth (default: 2)' },
          limit: { type: 'number', description: 'Max results (default: 20)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_workspace_context',
      description:
        'Get all known entities, relationships, and facts for a workspace. Use this at the start of a conversation to load relevant context from past work.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workspace: { type: 'string', description: 'Workspace path to get context for' },
          limit: { type: 'number', description: 'Max entities to return. Default: 500. Pass 200 for small contexts, 500 for 128K models, 1000 max for 200K+. Do NOT exceed 1000 — latency degrades significantly (>10s at 3000 on large DBs). Use search_memory for targeted recall instead.' },
        },
        required: ['workspace'],
      },
    },
    {
      name: 'save_conversation',
      description:
        'Save a completed conversation. Extracts entities, relationships, and facts into the knowledge graph. Raw text is discarded after extraction. Call this when a meaningful conversation ends.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workspace: { type: 'string', description: 'Workspace path where the conversation took place' },
          title: { type: 'string', description: 'Short title summarizing the conversation' },
          messages: {
            type: 'array',
            description: 'Array of conversation messages',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
                content: { type: 'string' },
              },
              required: ['role', 'content'],
            },
          },
        },
        required: ['workspace', 'messages'],
      },
    },
    {
      name: 'add_fact',
      description:
        'Store a specific fact about an entity. Use this to record decisions, patterns, conventions, or other knowledge that should persist.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          entityName: { type: 'string', description: 'Name of the entity (file, function, service, etc.)' },
          entityType: { type: 'string', description: 'Type of entity', enum: ['file', 'function', 'class', 'service', 'library', 'pattern', 'error', 'decision', 'config', 'endpoint', 'test', 'ticket'] },
          workspace: { type: 'string', description: 'Workspace path' },
          key: { type: 'string', description: 'Fact key (e.g. "pattern", "convention", "reason", "note")' },
          value: { type: 'string', description: 'Fact value' },
        },
        required: ['entityName', 'entityType', 'workspace', 'key', 'value'],
      },
    },
    {
      name: 'memory_status',
      description:
        'Show what is stored in the knowledge graph — list of workspaces, entity counts, fact counts, and date ranges. Use this to understand what the agent remembers.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'cleanup_memory',
      description:
        'Delete knowledge from a specific time range. Use this when the user wants to clear recent memory (e.g. "forget the last 2 hours" or "clean up today\'s memory"). Removes entities, facts, and relationships created within the specified time window.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          hours: { type: 'number', description: 'Delete knowledge from the last N hours (e.g. 1, 2, 24, 48)' },
          workspace: { type: 'string', description: 'Optional: limit cleanup to a specific workspace. If omitted, cleans all workspaces.' },
        },
        required: ['hours'],
      },
    },
    {
      name: 'forget_workspace',
      description:
        'Completely erase all knowledge for a specific workspace. Use this when the user wants a fresh start for a project, or when stored knowledge is outdated/wrong. This is irreversible.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workspace: { type: 'string', description: 'Workspace path to erase (e.g. "/Users/me/src/my-project")' },
          confirm: { type: 'boolean', description: 'Must be true to confirm deletion. This is irreversible.' },
        },
        required: ['workspace', 'confirm'],
      },
    },
    {
      name: 'index_codebase',
      description:
        'Index a codebase directory into the knowledge graph. Walks the file tree, parses each file to extract structure (exports, imports, functions, classes, interfaces, types), and stores structural summaries in the DB. Uses content hashing for incremental indexing — unchanged files are skipped. Run this on large legacy codebases so the agent can load code context from memory instead of re-reading files.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workspace: { type: 'string', description: 'Workspace root path to index (e.g. "/Users/me/src/my-project")' },
          pathPrefix: { type: 'string', description: 'Optional subdirectory to index (relative to workspace root, e.g. "src" or "packages/core")' },
          extensions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional file extensions to index (e.g. [".ts", ".py"]). If omitted, indexes all supported languages.',
          },
          force: { type: 'boolean', description: 'Force re-index even if files haven\'t changed. Default: false (incremental).' },
          maxFiles: { type: 'number', description: 'Max files to index in this run. Default: 5000.' },
        },
        required: ['workspace'],
      },
    },
    {
      name: 'get_code_context',
      description:
        'Load indexed code structure from the knowledge graph. Returns file structures (exports, imports, functions, classes, interfaces, types) and optionally source snippets (signatures, type definitions). Use this to understand a codebase without re-reading files. Works across workspaces — knowledge persists even after switching projects.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workspace: { type: 'string', description: 'Workspace path to load code context for' },
          pathPrefix: { type: 'string', description: 'Filter to files under this path prefix (e.g. "src/server" or "packages/core")' },
          language: { type: 'string', description: 'Filter by programming language (e.g. "typescript", "python")' },
          includeSnippets: { type: 'boolean', description: 'Include source code snippets (signatures, type defs). Default: false — returns structure only for token efficiency.' },
          limit: { type: 'number', description: 'Max files to return. Default: 100.' },
        },
        required: ['workspace'],
      },
    },
    {
      name: 'search_code',
      description:
        'Search indexed code across all workspaces by function name, class name, file path, or any structural element. Returns matching files with their structure and relations. Works cross-workspace — finds code even from other projects.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query — function name, class name, file path pattern, or any code identifier.' },
          workspace: { type: 'string', description: 'Optional: limit search to a specific workspace.' },
          limit: { type: 'number', description: 'Max results. Default: 20.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'save_prompt',
      description:
        'Save a prompt template for later reuse. Use this to store curated prompts (e.g. "review this code for security", "generate unit tests for...") with tags for easy retrieval. Conversation prompts are auto-captured — use this only for templates you want to save explicitly.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: 'The prompt text to save.' },
          title: { type: 'string', description: 'Short title for the prompt (e.g. "Security review prompt").' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization and search (e.g. ["security", "review", "code"]).' },
          workspace: { type: 'string', description: 'Optional: workspace this prompt is associated with.' },
        },
        required: ['content'],
      },
    },
    {
      name: 'search_prompts',
      description:
        'Search stored prompts by keyword or topic. Searches across prompt content, titles, and tags. Returns matching prompts sorted by relevance.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query — keyword, topic, or tag to search for in prompts.' },
          type: { type: 'string', enum: ['conversation', 'template'], description: 'Filter by prompt type. Omit to search all.' },
          workspace: { type: 'string', description: 'Filter to prompts from a specific workspace.' },
          limit: { type: 'number', description: 'Max results. Default: 50.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'list_prompts',
      description:
        'List stored prompts by date range, workspace, or type. Use this to browse prompts chronologically or filter by category.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          type: { type: 'string', enum: ['conversation', 'template'], description: 'Filter by prompt type. Omit to list all.' },
          workspace: { type: 'string', description: 'Filter to prompts from a specific workspace.' },
          days: { type: 'number', description: 'List prompts from the last N days. Default: all.' },
          limit: { type: 'number', description: 'Max results. Default: 50.' },
        },
      },
    },
    {
      name: 'top_prompts',
      description:
        'Rank prompts by usage frequency (most-used first) within a time period. Groups identical prompts and counts how many times each was used in the last day, week, month, or all time. With semantic grouping enabled (default), similar prompts are merged so different phrasings of the same request are counted together. Use this to see which prompts developers use most.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          period: { type: 'string', enum: ['day', 'week', 'month', 'all'], description: 'Time window to count usage over. Default: all.' },
          type: { type: 'string', enum: ['conversation', 'template'], description: 'Filter by prompt type. Omit to include all.' },
          workspace: { type: 'string', description: 'Filter to prompts from a specific workspace.' },
          semantic: { type: 'boolean', description: 'Merge semantically similar prompts into one ranked entry. Default: true.' },
          similarityThreshold: { type: 'number', description: 'Cosine similarity (0-1) required to merge prompts when semantic grouping is on. Higher = stricter. Default: 0.85.' },
          limit: { type: 'number', description: 'Max prompts to return. Default: 20.' },
        },
      },
    },
  ],
}));

/**
 * Derive a meaningful title from conversation messages when none is provided.
 * Uses first user message, falling back to first assistant message.
 */
function deriveTitleFromMessages(messages: Array<{ role: string; content: string }>): string {
  const firstUser = messages.find(m => m.role === 'user');
  if (firstUser) {
    let text = firstUser.content
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[#*_~>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length > 10) {
      if (text.length > 100) {
        const sentenceEnd = text.indexOf('. ', 30);
        if (sentenceEnd > 0 && sentenceEnd < 100) {
          text = text.slice(0, sentenceEnd + 1);
        } else {
          text = text.slice(0, 100).replace(/\s+\S*$/, '') + '\u2026';
        }
      }
      return text;
    }
  }

  const firstAssistant = messages.find(m => m.role === 'assistant');
  if (firstAssistant) {
    let text = firstAssistant.content
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, '')
      .replace(/[#*_~>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length > 100) {
      const sentenceEnd = text.indexOf('. ', 20);
      if (sentenceEnd > 0 && sentenceEnd < 100) {
        text = text.slice(0, sentenceEnd + 1);
      } else {
        text = text.slice(0, 100).replace(/\s+\S*$/, '') + '\u2026';
      }
    }
    if (text.length > 10) return text;
  }

  return `Session ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
}

// ─── Periodic inbox processing ──────────────────────────────

let lastInboxProcessed = 0;
const INBOX_POLL_INTERVAL_MS = 15_000; // 15 seconds

/**
 * Process inbox if enough time has passed since last check.
 * Called on every tool invocation to ensure captured conversations
 * are ingested without waiting for server restart.
 */
async function processInboxIfNeeded(): Promise<void> {
  const now = Date.now();
  if (now - lastInboxProcessed < INBOX_POLL_INTERVAL_MS) return;
  lastInboxProcessed = now;
  try {
    const count = await processInbox();
    if (count > 0) {
      process.stderr.write(`[inbox] Auto-processed ${count} conversations\n`);
    }
  } catch (err) {
    process.stderr.write(`[inbox] Background processing error: ${err}\n`);
  }
}

// ─── Tool implementations ───────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await db.init();

  // Process any pending inbox files before handling the tool call
  await processInboxIfNeeded();

  const { name, arguments: args } = request.params;

  switch (name) {
    case 'search_memory': {
      const q: GraphQuery = {
        entityName: args?.query as string,
        entityType: args?.type as GraphQuery['entityType'],
        workspace: args?.workspace as string | undefined,
        depth: (args?.depth as number) ?? 2,
        limit: (args?.limit as number) ?? 20,
      };

      const result = await db.query(q);

      // Also search conversation summaries semantically
      const summaryMatches = await db.searchBySummary(args?.query as string, 5);

      if (result.entities.length === 0 && summaryMatches.length === 0) {
        return { content: [{ type: 'text', text: `No entities found matching "${args?.query}".` }] };
      }

      const lines: string[] = [];

      if (result.entities.length > 0) {
        lines.push(`Found ${result.entities.length} entities:\n`);

        for (const entity of result.entities) {
          lines.push(`[${entity.type}] ${entity.name} (${entity.workspace})`);
          const entityFacts = result.facts.filter(f => f.entityId === entity.id);
          for (const fact of entityFacts) {
            lines.push(`  ${fact.key}: ${fact.value}`);
          }
        }

        if (result.relations.length > 0) {
          lines.push('\nRelationships:');
          for (const rel of result.relations) {
            const source = result.entities.find(e => e.id === rel.sourceId);
            const target = result.entities.find(e => e.id === rel.targetId);
            lines.push(`  ${source?.name || '?'} --${rel.type}--> ${target?.name || '?'}`);
            if (rel.context) lines.push(`    (${rel.context})`);
          }
        }

        if (result.conversations && result.conversations.length > 0) {
          lines.push('\nSource conversations:');
          for (const conv of result.conversations) {
            const date = new Date(conv.startedAt).toLocaleDateString();
            lines.push(`  [${date}] ${conv.title}${conv.summary ? ' — ' + conv.summary : ''}`);
          }
        }
      }

      // Add semantically similar conversations (deduplicated)
      const shownConvIds = new Set((result.conversations || []).map(c => c.id));
      const newSummaryMatches = summaryMatches.filter(c => !shownConvIds.has(c.id));
      if (newSummaryMatches.length > 0) {
        lines.push('\nRelated conversations (by summary):');
        for (const conv of newSummaryMatches) {
          const date = new Date(conv.startedAt).toLocaleDateString();
          lines.push(`  [${date}] ${conv.title}${conv.summary ? ' — ' + conv.summary : ''}`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    case 'get_workspace_context': {
      const workspace = args?.workspace as string;
      const limit = (args?.limit as number) ?? DEFAULT_CONTEXT_LIMIT;
      const result = await db.getWorkspaceContext(workspace, limit);

      if (result.entities.length === 0) {
        return { content: [{ type: 'text', text: `No knowledge stored for workspace: ${workspace}` }] };
      }

      const lines: string[] = [];
      lines.push(`Workspace: ${workspace}`);
      lines.push(`Entities: ${result.entities.length}, Relations: ${result.relations.length}, Facts: ${result.facts.length}\n`);

      for (const entity of result.entities) {
        lines.push(`[${entity.type}] ${entity.name}`);
        const entityFacts = result.facts.filter(f => f.entityId === entity.id);
        for (const fact of entityFacts) {
          lines.push(`  ${fact.key}: ${fact.value}`);
        }
      }

      if (result.relations.length > 0) {
        lines.push('\nRelationships:');
        for (const rel of result.relations) {
          const source = result.entities.find(e => e.id === rel.sourceId);
          const target = result.entities.find(e => e.id === rel.targetId);
          lines.push(`  ${source?.name || '?'} --${rel.type}--> ${target?.name || '?'}`);
        }
      }

      if (result.conversations && result.conversations.length > 0) {
        lines.push('\nRecent conversations:');
        for (const conv of result.conversations) {
          const date = new Date(conv.startedAt).toLocaleDateString();
          lines.push(`  [${date}] ${conv.title}${conv.summary ? ' — ' + conv.summary : ''}`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    case 'save_conversation': {
      const workspace = args?.workspace as string;
      const messages = args?.messages as Array<{ role: string; content: string }>;

      if (!messages || messages.length === 0) {
        return { content: [{ type: 'text', text: 'No messages provided.' }] };
      }

      // Derive title from conversation if not explicitly provided
      const title = (args?.title as string) || deriveTitleFromMessages(messages);

      const conversationId = `conv-${Date.now()}`;
      const rawMessages: RawMessage[] = messages.map((m, i) => ({
        id: `${conversationId}-${i}`,
        conversationId,
        role: m.role as RawMessage['role'],
        content: m.content,
        timestamp: Date.now(),
      }));

      // Extract knowledge
      const extractor = new Extractor(workspace, conversationId);
      const knowledge = extractor.extract(rawMessages);

      // Save conversation metadata (with auto-generated summary)
      await db.saveConversation({
        id: conversationId,
        workspace,
        projectName: workspace.split('/').pop() || '',
        ide: 'mcp',
        title,
        summary: knowledge.summary,
        startedAt: Date.now(),
        endedAt: Date.now(),
      });

      // Ingest into graph
      await db.ingestKnowledge(knowledge, conversationId);

      // Auto-capture user prompts
      for (const m of messages) {
        if (m.role === 'user' && m.content.trim().length > 10) {
          await db.savePrompt({
            content: m.content.trim(),
            type: 'conversation',
            title,
            workspace,
            conversationId,
          });
        }
      }

      return {
        content: [{
          type: 'text',
          text: `Saved: ${knowledge.entities.length} entities, ${knowledge.relations.length} relations, ${knowledge.facts.length} facts. Raw messages discarded.`,
        }],
      };
    }

    case 'add_fact': {
      const entityName = args?.entityName as string;
      const entityType = args?.entityType as string;
      const workspace = args?.workspace as string;
      const key = args?.key as string;
      const value = args?.value as string;

      const entity = await db.upsertEntity({
        type: entityType as any,
        name: entityName,
        workspace,
        metadata: {},
      });

      await db.upsertFact(
        {
          entityId: entity.id,
          key,
          value,
          confidence: 1.0,
          sourceConversationId: 'manual',
        },
        entity.id,
      );

      return {
        content: [{ type: 'text', text: `Stored fact: [${entityType}] ${entityName} → ${key}: ${value}` }],
      };
    }

    case 'memory_status': {
      const stats = await db.getMemoryStatus();

      if (stats.workspaces.length === 0) {
        return { content: [{ type: 'text', text: 'Knowledge graph is empty. No conversations have been stored yet.' }] };
      }

      const lines: string[] = [];
      lines.push('# ContextForge Status\n');
      lines.push(`Total: ${stats.totalEntities} entities, ${stats.totalFacts} facts, ${stats.totalRelations} relations`);
      
      const promptStats = await db.getPromptStats();
      if (promptStats.total > 0) {
        lines.push(`Prompts: ${promptStats.total} (${promptStats.templates} templates, ${promptStats.conversation} from conversations)`);
      }
      
      lines.push(`Database: ${stats.dbPath}\n`);
      lines.push('Workspaces:');
      for (const ws of stats.workspaces) {
        const age = ws.oldestEntity ? ` (oldest: ${new Date(ws.oldestEntity).toLocaleDateString()}, newest: ${new Date(ws.newestEntity!).toLocaleDateString()})` : '';
        lines.push(`  ${ws.workspace}: ${ws.entityCount} entities, ${ws.factCount} facts${age}`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    case 'cleanup_memory': {
      const hours = args?.hours as number;
      const workspace = args?.workspace as string | undefined;

      if (!hours || hours <= 0) {
        return { content: [{ type: 'text', text: 'Invalid hours value. Must be a positive number.' }], isError: true };
      }

      const cutoff = Date.now() - (hours * 60 * 60 * 1000);
      const deleted = await db.cleanupByTime(cutoff, workspace);

      const scope = workspace ? `workspace ${workspace}` : 'all workspaces';
      return {
        content: [{ type: 'text', text: `Cleaned up last ${hours} hours from ${scope}:\n  ${deleted.entities} entities removed\n  ${deleted.facts} facts removed\n  ${deleted.relations} relations removed` }],
      };
    }

    case 'forget_workspace': {
      const workspace = args?.workspace as string;
      const confirm = args?.confirm as boolean;

      if (!confirm) {
        return { content: [{ type: 'text', text: 'Deletion not confirmed. Set confirm: true to proceed. This is irreversible.' }], isError: true };
      }

      const deleted = await db.forgetWorkspace(workspace);

      return {
        content: [{ type: 'text', text: `Erased all knowledge for ${workspace}:\n  ${deleted.entities} entities removed\n  ${deleted.facts} facts removed\n  ${deleted.relations} relations removed\n  ${deleted.conversations} conversations removed` }],
      };
    }

    case 'index_codebase': {
      const workspace = args?.workspace as string;
      const pathPrefix = args?.pathPrefix as string | undefined;
      const extensions = args?.extensions as string[] | undefined;
      const force = args?.force as boolean | undefined;
      const maxFiles = args?.maxFiles as number | undefined;

      if (!workspace || !fs.existsSync(workspace)) {
        return { content: [{ type: 'text', text: `Workspace directory not found: ${workspace}` }], isError: true };
      }

      const indexer = new CodebaseIndexer(db);
      const result = await indexer.index(workspace, { pathPrefix, extensions, force, maxFiles });

      const lines: string[] = [];
      lines.push('# Codebase Indexing Complete\n');
      lines.push(`Workspace: ${workspace}${pathPrefix ? '/' + pathPrefix : ''}`);
      lines.push(`Files indexed: ${result.filesIndexed}`);
      lines.push(`Files unchanged (skipped): ${result.filesUnchanged}`);
      lines.push(`Files skipped (unsupported/too large): ${result.filesSkipped}`);
      lines.push(`Entities created: ${result.entitiesCreated}`);
      lines.push(`Relations created: ${result.relationsCreated}`);

      if (result.errors.length > 0) {
        lines.push(`\nWarnings/Errors (${result.errors.length}):`);
        for (const err of result.errors.slice(0, 20)) {
          lines.push(`  - ${err}`);
        }
      }

      lines.push('\nUse `get_code_context` to load the indexed structure, or `search_code` to find specific code.');

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    case 'get_code_context': {
      const workspace = args?.workspace as string;
      const pathPrefix = args?.pathPrefix as string | undefined;
      const language = args?.language as string | undefined;
      const includeSnippets = args?.includeSnippets as boolean | undefined;
      const limit = (args?.limit as number) ?? 100;

      const codeContent = await db.getCodeContext(workspace, { pathPrefix, language, limit });

      if (codeContent.length === 0) {
        return { content: [{ type: 'text', text: `No indexed code found for workspace: ${workspace}${pathPrefix ? '/' + pathPrefix : ''}\nRun index_codebase first to index the codebase.` }] };
      }

      const lines: string[] = [];
      lines.push(`# Code Context — ${workspace.split('/').pop() || workspace}`);
      lines.push(`${codeContent.length} files indexed${pathPrefix ? ` (filtered: ${pathPrefix})` : ''}\n`);

      for (const code of codeContent) {
        lines.push(`## ${code.filePath} (${code.language}, ${code.lineCount} lines)`);

        const s = code.structure;

        if (s.exports.length > 0) {
          lines.push(`  Exports: ${s.exports.join(', ')}`);
        }
        if (s.imports.length > 0) {
          lines.push(`  Imports: ${s.imports.map(i => `${i.name} from ${i.from}`).join('; ')}`);
        }
        if (s.functions.length > 0) {
          lines.push(`  Functions: ${s.functions.map(f => `${f.exported ? 'export ' : ''}${f.name}(${f.params})${f.returnType ? ': ' + f.returnType : ''}`).join('; ')}`);
        }
        if (s.classes.length > 0) {
          for (const cls of s.classes) {
            lines.push(`  Class: ${cls.exported ? 'export ' : ''}${cls.name}${cls.extends ? ' extends ' + cls.extends : ''}${cls.implements?.length ? ' implements ' + cls.implements.join(', ') : ''}`);
            if (cls.methods.length > 0) lines.push(`    Methods: ${cls.methods.join(', ')}`);
          }
        }
        if (s.interfaces.length > 0) lines.push(`  Interfaces: ${s.interfaces.join(', ')}`);
        if (s.types.length > 0) lines.push(`  Types: ${s.types.join(', ')}`);
        if (s.constants.length > 0) lines.push(`  Constants: ${s.constants.join(', ')}`);

        if (includeSnippets && code.sourceSnippet) {
          lines.push('  ```');
          lines.push(code.sourceSnippet);
          lines.push('  ```');
        }

        lines.push('');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    case 'search_code': {
      const query = args?.query as string;
      const workspace = args?.workspace as string | undefined;
      const limit = (args?.limit as number) ?? 20;

      const results = await db.searchCode(query, workspace, limit);

      if (results.length === 0) {
        return { content: [{ type: 'text', text: `No indexed code matching "${query}".${workspace ? '' : ' Try without workspace filter to search across all projects.'}` }] };
      }

      const lines: string[] = [];
      lines.push(`Found ${results.length} files matching "${query}":\n`);

      for (const code of results) {
        lines.push(`[${code.language}] ${code.filePath} (${code.workspace})`);
        const s = code.structure;
        if (s.exports.length > 0) lines.push(`  Exports: ${s.exports.slice(0, 10).join(', ')}${s.exports.length > 10 ? '...' : ''}`);
        if (s.functions.length > 0) lines.push(`  Functions: ${s.functions.map(f => f.name).join(', ')}`);
        if (s.classes.length > 0) lines.push(`  Classes: ${s.classes.map(c => c.name).join(', ')}`);
        if (code.sourceSnippet) {
          const snippet = code.sourceSnippet.length > 500
            ? code.sourceSnippet.slice(0, 500) + '\n// ...(truncated)'
            : code.sourceSnippet;
          lines.push('  ```');
          lines.push(snippet);
          lines.push('  ```');
        }
        lines.push('');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    case 'save_prompt': {
      const content = args?.content as string;
      const title = args?.title as string | undefined;
      const tags = args?.tags as string[] | undefined;
      const workspace = args?.workspace as string | undefined;

      if (!content) {
        return { content: [{ type: 'text', text: 'Prompt content is required.' }], isError: true };
      }

      const prompt = await db.savePrompt({
        content,
        type: 'template',
        title,
        tags,
        workspace,
      });

      return {
        content: [{ type: 'text', text: `Saved prompt template: "${prompt.title || content.slice(0, 60) + '…'}"${tags ? ' [' + tags.join(', ') + ']' : ''}` }],
      };
    }

    case 'search_prompts': {
      const query = args?.query as string;
      const type = args?.type as 'conversation' | 'template' | undefined;
      const workspace = args?.workspace as string | undefined;
      const limit = (args?.limit as number) ?? 50;

      const prompts = await db.searchPrompts(query, { type, workspace, limit });

      if (prompts.length === 0) {
        return { content: [{ type: 'text', text: `No prompts found matching "${query}".` }] };
      }

      const lines: string[] = [];
      lines.push(`Found ${prompts.length} prompts matching "${query}":\n`);
      for (const p of prompts) {
        const date = new Date(p.createdAt).toLocaleDateString();
        const tagStr = p.tags?.length ? ` [${p.tags.join(', ')}]` : '';
        const wsStr = p.workspace ? ` (${p.workspace.split('/').pop()})` : '';
        lines.push(`[${date}] [${p.type}]${tagStr}${wsStr}`);
        if (p.title) lines.push(`  Title: ${p.title}`);
        lines.push(`  ${p.content.length > 200 ? p.content.slice(0, 200) + '…' : p.content}`);
        lines.push('');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    case 'list_prompts': {
      const type = args?.type as 'conversation' | 'template' | undefined;
      const workspace = args?.workspace as string | undefined;
      const days = args?.days as number | undefined;
      const limit = (args?.limit as number) ?? 50;

      const since = days ? Date.now() - (days * 24 * 60 * 60 * 1000) : undefined;
      const prompts = await db.listPrompts({ type, workspace, since, limit });

      if (prompts.length === 0) {
        return { content: [{ type: 'text', text: 'No prompts found.' }] };
      }

      const stats = await db.getPromptStats();
      const lines: string[] = [];
      lines.push(`Prompts: ${stats.total} total (${stats.templates} templates, ${stats.conversation} from conversations)\n`);

      for (const p of prompts) {
        const date = new Date(p.createdAt).toLocaleDateString();
        const tagStr = p.tags?.length ? ` [${p.tags.join(', ')}]` : '';
        const wsStr = p.workspace ? ` (${p.workspace.split('/').pop()})` : '';
        lines.push(`[${date}] [${p.type}]${tagStr}${wsStr}`);
        if (p.title) lines.push(`  Title: ${p.title}`);
        lines.push(`  ${p.content.length > 200 ? p.content.slice(0, 200) + '…' : p.content}`);
        lines.push('');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    case 'top_prompts': {
      const period = (args?.period as 'day' | 'week' | 'month' | 'all') ?? 'all';
      const type = args?.type as 'conversation' | 'template' | undefined;
      const workspace = args?.workspace as string | undefined;
      const semantic = (args?.semantic as boolean | undefined) ?? true;
      const similarityThreshold = args?.similarityThreshold as number | undefined;
      const limit = (args?.limit as number) ?? 20;

      const periodMs: Record<'day' | 'week' | 'month', number> = {
        day: 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000,
        month: 30 * 24 * 60 * 60 * 1000,
      };
      const since = period === 'all' ? undefined : Date.now() - periodMs[period];

      const top = await db.getTopPrompts({ since, type, workspace, limit, semantic, similarityThreshold });

      const label = period === 'all' ? 'all time' : `last ${period}`;
      if (top.length === 0) {
        return { content: [{ type: 'text', text: `No prompts found for ${label}.` }] };
      }

      const lines: string[] = [];
      const groupNote = semantic ? ', semantically grouped' : '';
      lines.push(`# Top ${top.length} prompts by usage (${label}${groupNote})\n`);
      top.forEach((p, i) => {
        const wsStr = p.workspace ? ` (${p.workspace.split('/').pop()})` : '';
        const preview = p.content.replace(/\s+/g, ' ').trim();
        const truncated = preview.length > 150 ? preview.slice(0, 150) + '…' : preview;
        const times = p.count === 1 ? '1 use' : `${p.count} uses`;
        const variantNote = p.variants && p.variants > 1 ? `, ${p.variants} phrasings` : '';
        lines.push(`${i + 1}. [${times}${variantNote}] [${p.type}]${wsStr}`);
        if (p.title) lines.push(`   Title: ${p.title}`);
        lines.push(`   ${truncated}`);
        lines.push(`   Last used: ${new Date(p.lastUsed).toLocaleString()}`);
        lines.push('');
      });

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
});

// ─── Resource template (auto-injected workspace context) ────

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [
    {
      uriTemplate: 'contextforge://workspace/{workspace_path}',
      name: 'Workspace Knowledge',
      description:
        'Knowledge graph context for a workspace — entities, relationships, facts, and decisions from past conversations. Auto-attached to give the agent memory of previous work.',
      mimeType: 'text/plain',
    },
  ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  // List known workspaces that have stored knowledge
  await db.init();
  const workspaces = await db.getKnownWorkspaces();

  return {
    resources: workspaces.map((ws: string) => ({
      uri: `contextforge://workspace/${encodeURIComponent(ws)}`,
      name: `Knowledge: ${ws.split('/').pop() || ws}`,
      description: `Past conversation knowledge for ${ws}`,
      mimeType: 'text/plain',
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  await db.init();
  const uri = request.params.uri;

  // Parse workspace path from URI: contextforge://workspace/<encoded-path>
  const match = uri.match(/^contextforge:\/\/workspace\/(.+)$/);
  if (!match) {
    return {
      contents: [{ uri, mimeType: 'text/plain', text: `Unknown resource URI: ${uri}` }],
    };
  }

  const workspace = decodeURIComponent(match[1]);

  // Process any pending inbox files before reading
  await processInbox();

  const result = await db.getWorkspaceContext(workspace, DEFAULT_CONTEXT_LIMIT);

  if (result.entities.length === 0) {
    return {
      contents: [{
        uri,
        mimeType: 'text/plain',
        text: `No knowledge stored yet for workspace: ${workspace}\nAs you work, the contextforge tools will capture entities, decisions, and relationships.`,
      }],
    };
  }

  const lines: string[] = [];
  lines.push(`# Persistent Memory — ${workspace.split('/').pop() || workspace}`);
  lines.push(`This knowledge was extracted from past conversations. Use it to avoid re-asking questions, build on past decisions, and recall previous work.`);
  lines.push(`Entities: ${result.entities.length}, Relations: ${result.relations.length}, Facts: ${result.facts.length}`);
  lines.push(`(Sorted by most recently updated. Use search_memory tool for deeper queries.)\n`);

  // Group entities by type for better readability
  const byType = new Map<string, typeof result.entities>();
  for (const entity of result.entities) {
    const group = byType.get(entity.type) || [];
    group.push(entity);
    byType.set(entity.type, group);
  }

  const pluralize = (t: string) => t.endsWith('s') ? t + 'es' : t.endsWith('y') ? t.slice(0, -1) + 'ies' : t + 's';
  for (const [type, entities] of byType) {
    lines.push(`## ${pluralize(type)}`);
    for (const entity of entities) {
      const entityFacts = result.facts.filter(f => f.entityId === entity.id);
      if (entityFacts.length > 0) {
        lines.push(`- ${entity.name}: ${entityFacts.map(f => `${f.key}=${f.value}`).join('; ')}`);
      } else {
        lines.push(`- ${entity.name}`);
      }
    }
  }

  if (result.relations.length > 0) {
    lines.push(`\n## relationships`);
    for (const rel of result.relations) {
      const source = result.entities.find(e => e.id === rel.sourceId);
      const target = result.entities.find(e => e.id === rel.targetId);
      lines.push(`- ${source?.name || '?'} --${rel.type}--> ${target?.name || '?'}`);
    }
  }

  return {
    contents: [{ uri, mimeType: 'text/plain', text: lines.join('\n') }],
  };
});

// ─── Inbox processing ───────────────────────────────────────

/**
 * Determines if a conversation is worth persisting.
 * A conversation is substantive if ANY of the following are true:
 * - Files were modified (not just referenced)
 * - Decisions or patterns were extracted
 * - Facts were recorded
 * - The conversation involved meaningful workspace traversal (files referenced + enough content)
 * 
 * Trivial conversations (status checks, simple Q&A with no code/file context) are filtered out.
 */
function isSubstantiveConversation(knowledge: ExtractedKnowledge, messages: RawMessage[]): boolean {
  // 1. Any decisions or patterns extracted → keep
  const hasDecisions = knowledge.entities.some(e => e.type === 'decision' || e.type === 'pattern');
  if (hasDecisions) return true;

  // 2. Any facts recorded → keep
  if (knowledge.facts.length > 0) return true;

  // 3. Any files were modified → keep
  const hasModifiedFiles = Array.from(knowledge.entityRoles.values()).some(role => role === 'modified');
  if (hasModifiedFiles) return true;

  // 4. Any entities extracted at all with reasonable content → keep
  // (Even 1 entity with substantive discussion is worth keeping)
  if (knowledge.entities.length >= 1) {
    const totalContent = messages.reduce((acc, m) => acc + m.content.length, 0);
    if (totalContent > 500) return true;
  }

  // 5. Multiple entities → always keep (meaningful traversal)
  if (knowledge.entities.length >= 2) return true;

  // 6. Long conversation even without entities (architectural discussions)
  const totalContent = messages.reduce((acc, m) => acc + m.content.length, 0);
  if (messages.length >= 4 && totalContent > 1500) return true;

  // 7. Any errors extracted → keep (debugging sessions)
  const hasErrors = knowledge.entities.some(e => e.type === 'error');
  if (hasErrors) return true;

  // Otherwise: trivial (status check, greeting, simple question)
  return false;
}

function getInboxDir(): string {
  // Inbox lives alongside the database file for per-agent isolation
  const dbDir = path.dirname(process.env.CONTEXTFORGE_DB_PATH || path.join(os.homedir(), '.contextforge', 'contextforge.db'));
  return process.env.CONTEXTFORGE_INBOX_DIR || path.join(dbDir, 'inbox');
}

async function processInbox(): Promise<number> {
  const inboxDir = getInboxDir();
  if (!fs.existsSync(inboxDir)) return 0;

  const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'));
  let processed = 0;

  for (const file of files) {
    const filepath = path.join(inboxDir, file);
    try {
      const raw = fs.readFileSync(filepath, 'utf8');
      const entry = JSON.parse(raw) as {
        sessionId: string;
        workspace: string;
        title: string;
        messages: RawMessage[];
        capturedAt: number;
      };

      if (!entry.messages || entry.messages.length < 2) {
        fs.unlinkSync(filepath);
        continue;
      }

      await db.init();
      const convId = entry.sessionId;
      const extractor = new Extractor(entry.workspace, convId);
      const knowledge = extractor.extract(entry.messages);

      // Skip trivial conversations that produced no actionable knowledge:
      // - No entities extracted (no files, decisions, patterns, libraries, etc.)
      // - No files modified
      // - No facts/decisions recorded
      // These are typically status checks, simple Q&A, or greetings.
      if (!isSubstantiveConversation(knowledge, entry.messages)) {
        process.stderr.write(`[inbox] Skipping trivial conversation: "${entry.title || convId}"\n`);
        fs.unlinkSync(filepath);
        continue;
      }

      await db.saveConversation({
        id: convId,
        workspace: entry.workspace,
        projectName: path.basename(entry.workspace),
        ide: 'vscode',
        title: entry.title || deriveTitleFromMessages(entry.messages),
        summary: knowledge.summary,
        startedAt: entry.capturedAt,
        endedAt: entry.capturedAt,
      });

      await db.ingestKnowledge(knowledge, convId);
      
      // Auto-capture user prompts from the conversation
      const convTitle = entry.title || deriveTitleFromMessages(entry.messages);
      for (const msg of entry.messages) {
        if (msg.role === 'user' && msg.content.trim().length > 10) {
          await db.savePrompt({
            content: msg.content.trim(),
            type: 'conversation',
            title: convTitle,
            workspace: entry.workspace,
            conversationId: convId,
          });
        }
      }
      
      fs.unlinkSync(filepath);
      processed++;
    } catch (err) {
      process.stderr.write(`[inbox] Error processing ${file}: ${err}\n`);
      // Move to .error to avoid infinite retry
      try {
        fs.renameSync(filepath, filepath + '.error');
      } catch { /* ignore */ }
    }
  }

  return processed;
}

// ─── CLI mode ────────────────────────────────────────────────

function cliHelp(): void {
  process.stdout.write(`
contextforge — knowledge graph CLI

Usage:
  contextforge <command> [options]
  contextforge              (no args) — start MCP server

Commands:
  search <query>            Search memory (entities + conversations)
  status                    Show memory status
  context <workspace>       Load all context for a workspace
  add <name> <type> <workspace> <key> <value>  Store a fact
  forget <workspace>        Erase all knowledge for a workspace (requires --confirm)
  prompts search <query>    Search stored prompts
  prompts list              List stored prompts
  prompts top               Show most-used prompts

Options:
  --workspace, -w <path>    Filter by workspace
  --type, -t <type>         Filter by entity type
  --limit, -l <n>           Max results (default: 20)
  --days <n>                Filter to last N days (prompts list)
  --period <p>              day|week|month|all (prompts top, default: all)
  --json                    Output raw JSON
  --confirm                 Confirm destructive operations
  --help, -h                Show this help
`.trimStart());
}

interface CliFlags {
  workspace?: string;
  type?: string;
  limit?: number;
  days?: number;
  period?: string;
  json?: boolean;
  confirm?: boolean;
}

function parseFlags(args: string[]): { positional: string[]; flags: CliFlags } {
  const positional: string[] = [];
  const flags: CliFlags = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--workspace' || arg === '-w') { flags.workspace = args[++i]; }
    else if (arg === '--type' || arg === '-t') { flags.type = args[++i]; }
    else if (arg === '--limit' || arg === '-l') { flags.limit = parseInt(args[++i], 10); }
    else if (arg === '--days') { flags.days = parseInt(args[++i], 10); }
    else if (arg === '--period') { flags.period = args[++i]; }
    else if (arg === '--json') { flags.json = true; }
    else if (arg === '--confirm') { flags.confirm = true; }
    else if (!arg.startsWith('-')) { positional.push(arg); }
    i++;
  }
  return { positional, flags };
}

async function runCli(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    cliHelp();
    return;
  }

  const command = argv[0];
  const rest = argv.slice(1);

  await db.init();

  switch (command) {
    case 'search': {
      const { positional, flags } = parseFlags(rest);
      const query = positional.join(' ');
      if (!query) {
        process.stderr.write('Usage: contextforge search <query> [--workspace <path>] [--type <type>] [--limit <n>]\n');
        process.exit(1);
      }

      const q: GraphQuery = {
        entityName: query,
        entityType: flags.type as GraphQuery['entityType'],
        workspace: flags.workspace,
        depth: 2,
        limit: flags.limit ?? 20,
      };

      const result = await db.query(q);
      const summaryMatches = await db.searchBySummary(query, 5);

      if (flags.json) {
        process.stdout.write(JSON.stringify({ entities: result.entities, facts: result.facts, relations: result.relations, conversations: summaryMatches }, null, 2) + '\n');
        break;
      }

      if (result.entities.length === 0 && summaryMatches.length === 0) {
        process.stdout.write(`No results found for "${query}".\n`);
        break;
      }

      if (result.entities.length > 0) {
        process.stdout.write(`Found ${result.entities.length} entities:\n\n`);
        for (const entity of result.entities) {
          process.stdout.write(`[${entity.type}] ${entity.name} (${entity.workspace})\n`);
          const entityFacts = result.facts.filter(f => f.entityId === entity.id);
          for (const fact of entityFacts) {
            process.stdout.write(`  ${fact.key}: ${fact.value}\n`);
          }
        }
      }

      const shownConvIds = new Set((result.conversations || []).map(c => c.id));
      const newSummaryMatches = summaryMatches.filter(c => !shownConvIds.has(c.id));
      if (newSummaryMatches.length > 0) {
        process.stdout.write('\nRelated conversations (by summary):\n');
        for (const conv of newSummaryMatches) {
          const date = new Date(conv.startedAt).toLocaleDateString();
          const summarySnip = conv.summary ? ' — ' + conv.summary.slice(0, 100) : '';
          process.stdout.write(`  [${date}] ${conv.title}${summarySnip}\n`);
        }
      }
      break;
    }

    case 'status': {
      const { flags } = parseFlags(rest);
      const stats = await db.getMemoryStatus();
      const promptStats = await db.getPromptStats();

      if (flags.json) {
        process.stdout.write(JSON.stringify({ ...stats, prompts: promptStats }, null, 2) + '\n');
        break;
      }

      if (stats.workspaces.length === 0) {
        process.stdout.write('Knowledge graph is empty.\n');
        break;
      }

      process.stdout.write(`Total: ${stats.totalEntities} entities, ${stats.totalFacts} facts, ${stats.totalRelations} relations\n`);
      if (promptStats.total > 0) {
        process.stdout.write(`Prompts: ${promptStats.total} (${promptStats.templates} templates, ${promptStats.conversation} from conversations)\n`);
      }
      process.stdout.write(`Database: ${stats.dbPath}\n\nWorkspaces:\n`);
      for (const ws of stats.workspaces) {
        const age = ws.oldestEntity
          ? ` (oldest: ${new Date(ws.oldestEntity).toLocaleDateString()}, newest: ${new Date(ws.newestEntity!).toLocaleDateString()})`
          : '';
        process.stdout.write(`  ${ws.workspace}: ${ws.entityCount} entities, ${ws.factCount} facts${age}\n`);
      }
      break;
    }

    case 'context': {
      const { positional, flags } = parseFlags(rest);
      const workspace = positional[0] || flags.workspace;
      if (!workspace) {
        process.stderr.write('Usage: contextforge context <workspace> [--limit <n>] [--json]\n');
        process.exit(1);
      }
      const expandedWorkspace = expandTilde(workspace);
      const result = await db.getWorkspaceContext(expandedWorkspace, flags.limit ?? DEFAULT_CONTEXT_LIMIT);

      if (flags.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        break;
      }

      if (result.entities.length === 0) {
        process.stdout.write(`No knowledge stored for workspace: ${expandedWorkspace}\n`);
        break;
      }

      process.stdout.write(`Workspace: ${expandedWorkspace}\nEntities: ${result.entities.length}, Relations: ${result.relations.length}, Facts: ${result.facts.length}\n\n`);
      for (const entity of result.entities) {
        process.stdout.write(`[${entity.type}] ${entity.name}\n`);
        const entityFacts = result.facts.filter(f => f.entityId === entity.id);
        for (const fact of entityFacts) {
          process.stdout.write(`  ${fact.key}: ${fact.value}\n`);
        }
      }
      if (result.conversations && result.conversations.length > 0) {
        process.stdout.write('\nRecent conversations:\n');
        for (const conv of result.conversations) {
          const date = new Date(conv.startedAt).toLocaleDateString();
          const summarySnip = conv.summary ? ' — ' + conv.summary.slice(0, 100) : '';
          process.stdout.write(`  [${date}] ${conv.title}${summarySnip}\n`);
        }
      }
      break;
    }

    case 'add': {
      const { positional } = parseFlags(rest);
      const [entityName, entityType, workspace, key, ...valueParts] = positional;
      const value = valueParts.join(' ');
      if (!entityName || !entityType || !workspace || !key || !value) {
        process.stderr.write('Usage: contextforge add <entityName> <entityType> <workspace> <key> <value>\n');
        process.exit(1);
      }

      const entity = await db.upsertEntity({
        type: entityType as any,
        name: entityName,
        workspace: expandTilde(workspace),
        metadata: {},
      });
      await db.upsertFact(
        { entityId: entity.id, key, value, confidence: 1.0, sourceConversationId: 'manual' },
        entity.id,
      );
      process.stdout.write(`Stored: [${entityType}] ${entityName} → ${key}: ${value}\n`);
      break;
    }

    case 'forget': {
      const { positional, flags } = parseFlags(rest);
      const workspace = positional[0] || flags.workspace;
      if (!workspace) {
        process.stderr.write('Usage: contextforge forget <workspace> --confirm\n');
        process.exit(1);
      }
      if (!flags.confirm) {
        process.stderr.write('Add --confirm to erase all knowledge for this workspace. This is irreversible.\n');
        process.exit(1);
      }

      const deleted = await db.forgetWorkspace(expandTilde(workspace));
      process.stdout.write(`Erased all knowledge for ${workspace}:\n  ${deleted.entities} entities\n  ${deleted.facts} facts\n  ${deleted.relations} relations\n  ${deleted.conversations} conversations\n`);
      break;
    }

    case 'prompts': {
      const subcommand = rest[0];
      const subRest = rest.slice(1);
      const { positional, flags } = parseFlags(subRest);

      if (subcommand === 'search') {
        const query = positional.join(' ');
        if (!query) {
          process.stderr.write('Usage: contextforge prompts search <query> [--type <type>] [--workspace <path>] [--limit <n>]\n');
          process.exit(1);
        }

        const prompts = await db.searchPrompts(query, { type: flags.type as any, workspace: flags.workspace, limit: flags.limit ?? 50 });
        if (flags.json) { process.stdout.write(JSON.stringify(prompts, null, 2) + '\n'); break; }
        if (prompts.length === 0) { process.stdout.write(`No prompts found for "${query}".\n`); break; }

        process.stdout.write(`Found ${prompts.length} prompts matching "${query}":\n\n`);
        for (const p of prompts) {
          const date = new Date(p.createdAt).toLocaleDateString();
          const wsStr = p.workspace ? ` (${p.workspace.split('/').pop()})` : '';
          process.stdout.write(`[${date}] [${p.type}]${wsStr}\n`);
          if (p.title) process.stdout.write(`  Title: ${p.title}\n`);
          process.stdout.write(`  ${p.content.length > 200 ? p.content.slice(0, 200) + '…' : p.content}\n\n`);
        }

      } else if (subcommand === 'list') {
        const since = flags.days ? Date.now() - (flags.days * 24 * 60 * 60 * 1000) : undefined;
        const prompts = await db.listPrompts({ type: flags.type as any, workspace: flags.workspace, since, limit: flags.limit ?? 50 });
        if (flags.json) { process.stdout.write(JSON.stringify(prompts, null, 2) + '\n'); break; }

        const stats = await db.getPromptStats();
        process.stdout.write(`Prompts: ${stats.total} total (${stats.templates} templates, ${stats.conversation} from conversations)\n\n`);
        for (const p of prompts) {
          const date = new Date(p.createdAt).toLocaleDateString();
          const wsStr = p.workspace ? ` (${p.workspace.split('/').pop()})` : '';
          process.stdout.write(`[${date}] [${p.type}]${wsStr}\n`);
          if (p.title) process.stdout.write(`  Title: ${p.title}\n`);
          process.stdout.write(`  ${p.content.length > 200 ? p.content.slice(0, 200) + '…' : p.content}\n\n`);
        }

      } else if (subcommand === 'top') {
        const period = (flags.period as 'day' | 'week' | 'month' | 'all') ?? 'all';
        const periodMs: Record<'day' | 'week' | 'month', number> = {
          day: 86_400_000,
          week: 604_800_000,
          month: 2_592_000_000,
        };
        const since = period === 'all' ? undefined : Date.now() - periodMs[period];
        const top = await db.getTopPrompts({ since, type: flags.type as any, workspace: flags.workspace, limit: flags.limit ?? 20, semantic: true });
        if (flags.json) { process.stdout.write(JSON.stringify(top, null, 2) + '\n'); break; }

        const label = period === 'all' ? 'all time' : `last ${period}`;
        if (top.length === 0) { process.stdout.write(`No prompts for ${label}.\n`); break; }

        process.stdout.write(`Top ${top.length} prompts by usage (${label}, semantically grouped):\n\n`);
        top.forEach((p, i) => {
          const preview = p.content.replace(/\s+/g, ' ').trim();
          const truncated = preview.length > 150 ? preview.slice(0, 150) + '…' : preview;
          const times = p.count === 1 ? '1 use' : `${p.count} uses`;
          const variantNote = p.variants && p.variants > 1 ? `, ${p.variants} phrasings` : '';
          const wsStr = p.workspace ? ` (${p.workspace.split('/').pop()})` : '';
          process.stdout.write(`${i + 1}. [${times}${variantNote}]${wsStr}\n`);
          if (p.title) process.stdout.write(`   ${p.title}\n`);
          process.stdout.write(`   ${truncated}\n   Last used: ${new Date(p.lastUsed).toLocaleString()}\n\n`);
        });

      } else {
        process.stderr.write('Usage: contextforge prompts <search|list|top> [options]\n');
        process.exit(1);
      }
      break;
    }

    default:
      process.stderr.write(`Unknown command: ${command}\nRun "contextforge --help" for usage.\n`);
      process.exit(1);
  }

  await db.close();
}

// ─── Start ──────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Process any pending inbox files on startup
  try {
    await db.init();
    const count = await processInbox();
    if (count > 0) {
      process.stderr.write(`[inbox] Processed ${count} pending conversations on startup\n`);
    }
  } catch (err) {
    process.stderr.write(`[inbox] Startup processing error: ${err}\n`);
  }

  // Start periodic inbox polling (every 30s) to catch conversations
  // captured while no tool calls are being made
  const BACKGROUND_POLL_MS = 30_000;
  setInterval(async () => {
    try {
      await db.init();
      const count = await processInbox();
      if (count > 0) {
        process.stderr.write(`[inbox] Background poll: processed ${count} conversations\n`);
      }
    } catch (err) {
      process.stderr.write(`[inbox] Background poll error: ${err}\n`);
    }
  }, BACKGROUND_POLL_MS);
}

// If any CLI arguments are provided (and not the MCP flag), run in CLI mode.
// Otherwise start the MCP stdio server as usual.
const cliArgs = process.argv.slice(2);
if (cliArgs.length > 0 && !cliArgs.includes('--mcp')) {
  runCli(cliArgs).catch((err) => {
    process.stderr.write(`${err}\n`);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    process.stderr.write(`ContextForge MCP server error: ${err}\n`);
    process.exit(1);
  });
}
