# ContextForge

Provided by [AdoptNow.AI](https://adoptnow.ai). AdoptNow.AI is currently a project domain, not a registered company.

**Graph-based knowledge storage for AI coding agents — works with any IDE via MCP.**

ContextForge captures your conversations with AI coding agents (Copilot, Cursor, JetBrains AI, etc.), extracts structured knowledge into a graph database, and makes it available across all your projects and workspaces. Instead of agents starting every conversation from scratch, they can build on past decisions, patterns, and context.

Distributed as a **single binary** — no source code, no npm install, no runtime dependencies.

---

## Table of Contents

- [The Problem](#the-problem)
- [How It Works](#how-it-works)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [MCP Tools](#mcp-tools)
- [Knowledge Graph Design](#knowledge-graph-design)
- [Extraction Engine](#extraction-engine)
- [Configuration](#configuration)
- [Data Storage](#data-storage)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)
- [License](#license)

---

## The Problem

AI coding agents are stateless. Every new conversation starts from zero — the agent doesn't remember:

- What files were changed last week and why
- What architectural decisions were made
- What errors were encountered and how they were fixed
- What libraries, patterns, and conventions the project uses

Raw conversation logs are **huge** (50-200KB each) and full of noise (tool output, repeated system prompts, file contents). Storing and searching them is expensive and slow.

## How It Works

ContextForge solves this with a **3-step pipeline**:

```
Step 1: Capture          Step 2: Extract            Step 3: Query
┌──────────────┐       ┌────────────────────┐     ┌───────────────────┐
│ Agent talks   │──────▶│ Extractor pulls    │────▶│ Graph DB stores   │
│ to user       │       │ entities, facts,   │     │ only structured   │
│ (50-200KB)    │       │ relations          │     │ knowledge (2-5KB) │
└──────────────┘       └────────────────────┘     └───────────────────┘
                              │                          │
                              ▼                          ▼
                     Raw text DISCARDED          Graph is queryable
                                                 across all projects
```

**Result**: 96% smaller storage, instant graph queries, knowledge that persists across workspaces and IDEs.

The agent calls MCP tools automatically — no manual invocation needed. The tools are available to any IDE that supports MCP (VS Code, Cursor).

### What gets extracted

| Extracted | Example |
|-----------|---------|
| **Files** | `auth.ts`, `middleware.ts`, `package.json` |
| **Functions/Classes** | `handleLogin()`, `UserService`, `AuthMiddleware` |
| **Libraries** | `express`, `react`, `jsonwebtoken` |
| **Errors** | `TypeError: Cannot read property 'id' of undefined` |
| **Decisions** | "Used JWT instead of sessions because it scales better" |
| **Relationships** | `auth.ts` → uses → `jsonwebtoken`, `auth.test.ts` → tests → `auth.ts` |

### What gets discarded

- Raw file contents that were shown to the agent
- Tool call outputs (grep results, terminal output)
- System prompts and context blocks
- Repeated/duplicate content

---

## Quick Start

### 1. Copy the release folder

```bash
cp -r release/ ~/.contextforge/
chmod +x ~/.contextforge/contextforge
```

### 2. Configure MCP server in your IDE

**VS Code / Cursor** — open the global MCP config (Cmd+Shift+P → "MCP: Open User Configuration") and add:

```json
{
  "servers": {
    "contextforge": {
      "command": "/Users/<username>/.contextforge/contextforge",
      "type": "stdio"
    }
  }
}
```

Replace `<username>` with your macOS username. This is global — works across all projects.

### MCP setup by client

MCP registration and agent instructions are separate. Register the server first, then install or enable the client-specific instructions so the agent actually retrieves and saves memory.

| Client | MCP registration location | Instruction location |
| --- | --- | --- |
| VS Code / Copilot | Project: `.vscode/mcp.json`; global: `MCP: Open User Configuration` | Project: `.github/instructions/contextforge-memory.instructions.md`; global: `~/Library/Application Support/Code/User/prompts/contextforge.instructions.md` |
| Claude Code | Project: `.mcp.json`; global: `claude mcp add --scope user ...` | Project: `CLAUDE.md`; global: add the same rules to your user-level Claude instructions |
| Other CLI MCP clients | The client's MCP JSON/config file, using a stdio server entry | The client's instruction or rules file; there is no universal CLI location |

For a packaged installation, use the absolute executable path in the MCP entry:

```json
{
  "contextforge": {
    "type": "stdio",
    "command": "/Users/<username>/.contextforge/contextforge",
    "args": []
  }
}
```

VS Code uses the `servers` wrapper:

```json
{
  "servers": {
    "contextforge": {
      "type": "stdio",
      "command": "/Users/<username>/.contextforge/contextforge",
      "args": []
    }
  }
}
```

Claude Code uses the `mcpServers` wrapper. The project command is:

```bash
claude mcp add --transport stdio --scope project contextforge -- /Users/<username>/.contextforge/contextforge
```

For a source checkout, replace the packaged command with an absolute Node executable and the built server path. Set `CONTEXTFORGE_MODEL_DIR` to `packages/core/release/models` when semantic search model files are not bundled beside the server. After changing configuration, reload or restart the client and confirm that `contextforge` is connected.

### 3. Add agent instructions (so agents use memory automatically)

The MCP server alone makes tools *available* — but agents won't use them unless instructed. This step ensures every conversation automatically stores and retrieves knowledge.

**VS Code / Cursor** — create the file `~/Library/Application Support/Code/User/prompts/contextforge.instructions.md`:

```markdown
---
description: "Use when: starting any conversation, recalling past work, ending a conversation. Manages persistent memory across all workspaces using the contextforge MCP tools."
---

# ContextForge

You have access to a persistent knowledge graph via MCP tools that remembers context across all conversations and workspaces.

## At the start of every conversation

1. Call `get_workspace_context` with the current workspace path to load known entities, decisions, patterns, and facts from past conversations.
2. Use this context to avoid re-asking questions the user already answered, and to build on past decisions.

## During the conversation

- When the user asks about past work, decisions, or patterns, call `search_memory` to find relevant entities.
- When the user asks to refer to a Rally ticket (for example `US12345` or `TF6789`), call `get_rally_work_item` to fetch the latest details from Rally.
- When a notable decision, pattern, or convention is established, call `add_fact` to persist it immediately.

## At the end of a meaningful conversation

- When significant work was done (code changes, architectural decisions, bug fixes, new patterns), call `save_conversation` with the workspace path and the conversation messages.
- This extracts entities, relationships, and facts into the graph. Raw text is discarded.
- Skip this for trivial questions or one-off lookups.

## Tool summary

| Tool | When to use |
|------|-------------|
| `get_workspace_context` | Start of conversation — load past knowledge |
| `search_memory` | Recall past work, decisions, errors, patterns |
| `add_fact` | Persist a decision, convention, or insight immediately |
| `get_rally_work_item` | Fetch live Rally details for TF/US references |
| `save_conversation` | End of meaningful conversation — extract and store knowledge |
| `memory_status` | Check how much is stored, which workspaces have data |
| `cleanup_memory` | Remove old knowledge by time range (optionally per workspace) |
| `forget_workspace` | Completely remove all knowledge for a workspace |
```

This file is **user-level** — it applies globally across all projects automatically.

### 4. Install the Capture Extension (automatic conversation saving)

Steps 2-3 set up the **read side** (agent retrieves knowledge) and **instruction-driven write** (agent calls `save_conversation`). The capture extension adds **automatic write** — conversations are saved to the knowledge graph without the agent needing to cooperate.

**VS Code / Cursor**:

```bash
# Install the VSIX from the release folder
code --install-extension release/contextforge-capture-0.1.0.vsix
```

Or: Open VS Code → Cmd+Shift+P → "Extensions: Install from VSIX..." → select the `.vsix` file.

The extension automatically:
- Watches Copilot Chat session files for completed conversations
- Extracts messages and writes them to `~/.contextforge/inbox/`
- The MCP server processes the inbox on its next call

You'll see a status bar item: `$(database) Memory: active`.

Chat commands:
- `@memory /save` — manually save the current conversation immediately
- `@memory /status` — show capture status

Settings (via VS Code Settings UI → "ContextForge"):
- `contextforge.autoCapture` — enable/disable auto-capture (default: true)
- `contextforge.captureDelaySeconds` — seconds to wait after last write before capturing (default: 30)
- `contextforge.minMessages` — minimum messages to capture a session (default: 2)

### 5. Verify

Start a new conversation with your AI agent and check:

1. The agent should call `get_workspace_context` at the start
2. Ask: *"What do you know about this project from past conversations?"* — it should call `search_memory`
3. On first use, results will be empty — the database populates as you have conversations

---

## Architecture

```
                    WRITE PATH                              READ PATH
                    ──────────                              ─────────
┌──────────────────────────────────┐          ┌──────────────────────────────────┐
│  Capture Extension (in IDE)      │          │  Agent (in IDE)                  │
│                                  │          │                                  │
│  Watches chat sessions,          │          │  MCP resource auto-injected      │
│  extracts messages,              │          │  into context on start.          │
│  writes to inbox.                │          │  MCP tools called on demand.     │
│  (VS Code extension)            │          │                                  │
└─────────────┬────────────────────┘          └───────────────┬──────────────────┘
              │                                               │
              ▼                                               │
    ~/.contextforge/inbox/                                    │
    (JSON files: sessionId,                                   │
     workspace, messages)                                     │
              │                                               │
              ▼                                               ▼
         ┌──────────────────────────────────────────────────────────┐
         │                  MCP Server (contextforge binary)        │
         │                                                          │
         │  On startup + before reads: processInbox()               │
         │    → parse inbox JSON → extract knowledge → ingest       │
         │                                                          │
         │  Tools (8): search_memory, get_workspace_context,        │
         │    save_conversation, add_fact, get_rally_work_item,     │
         │    memory_status, cleanup_memory, forget_workspace       │
         │                                                          │
         │  Resource: contextforge://workspace/{path}               │
         │    → auto-injected into agent context                    │
         │                                                          │
         │  ┌──────────────┐  ┌──────────────┐                     │
         │  │ Extractor    │  │MemoryDatabase│                     │
         │  │ (no LLM)    │  │ (SQLite)     │                     │
         │  └──────────────┘  └──────┬───────┘                     │
         └───────────────────────────┼─────────────────────────────┘
                                     │
                                     ▼
                           ~/.contextforge/contextforge.db
```

### Data Flow — Step by Step

#### Write Path (automatic capture)

```
┌─────────────────────────────────────┐
│  1. User chats with Copilot in IDE  │
│     (VS Code)                       │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  2. IDE writes session to disk      │
│     chatSessions/<id>.jsonl         │
│     (JSONL event log format)        │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  3. Capture Extension detects       │
│     change via FileSystemWatcher    │
│     (30-second debounce)            │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  4. Extension parses JSONL,         │
│     extracts messages, writes       │
│     JSON to inbox                   │
│     ~/.contextforge/inbox/          │
│       session-<id>-<ts>.json        │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  5. MCP Server processInbox()       │
│     runs on startup + before        │
│     each resource read              │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  6. Extractor (rule-based, no LLM)  │
│     extracts entities, relations,   │
│     facts from messages             │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  7. SQLite Database                 │
│     ~/.contextforge/contextforge.db       │
│     Entities, Facts, Relations      │
│     stored permanently              │
└─────────────────────────────────────┘
```

#### Read Path (agent queries)

```
┌─────────────────────────────────────┐
│  1. New conversation starts         │
│     IDE auto-reads MCP resource     │
│     contextforge://workspace/...    │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  2. MCP Server queries SQLite DB   │
│     Returns entities, facts,        │
│     relationships for workspace     │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  3. Knowledge injected into agent   │
│     context — agent sees past       │
│     decisions, patterns, errors     │
│     before first user message       │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  4. During conversation, agent      │
│     calls search_memory, add_fact   │
│     on demand via MCP tools         │
└─────────────────────────────────────┘
```

#### Inbox Format

Each file in `~/.contextforge/inbox/` is a JSON document:

```json
{
  "sessionId": "abc123-...",
  "workspace": "/Users/you/src/my-project",
  "title": "Fix auth middleware bug",
  "messages": [
    { "role": "user", "content": "The login endpoint returns 401..." },
    { "role": "assistant", "content": "The JWT expiry check in auth.ts..." }
  ],
  "capturedAt": 1776885043000
}
```

The MCP server reads this, runs the Extractor, ingests into the graph DB, and deletes the file. Failed files are renamed to `.error` for debugging.

### Three pieces, three purposes

| Piece | What it does | Where it lives |
|-------|-------------|----------------|
| **MCP config** | Tells the IDE *where* to find the server binary | `mcp.json` (VS Code) |
| **Agent instructions** | Tells the agent *when and how* to call tools + when to save | `instructions.md` (VS Code) |
| **Capture extension** | Automatically writes conversations to inbox for MCP processing | VS Code extension |

The capture extension is optional — without it, the agent still saves conversations via instructions. The extension adds reliability (auto-capture) and catches conversations where the agent forgot to call `save_conversation`.

### Why this architecture?

- **MCP protocol** — works with any IDE that supports MCP, no custom plugins needed
- **Single binary** — no Node.js, no npm install, no runtime dependencies for end users
- **One global database** — all workspaces write to the same graph, so agents remember context from any project
- **stdio transport** — the IDE starts/stops the process automatically, no port management
- **No LLM required** — extraction is rule-based, works offline, zero API costs

---

## MCP Tools & Resources

The MCP server exposes **8 tools** (agent calls on demand) and **1 resource template** (IDE auto-attaches to context).

### Resource: Workspace Knowledge (auto-injected)

```
URI template: contextforge://workspace/{workspace_path}
```

The IDE reads this resource **automatically** and injects it into the agent's context at the start of every conversation. The agent doesn't need to call anything — the IDE attaches the workspace knowledge before the first message.

This is what makes it work with **any model**, including cheaper ones that can't reliably follow tool-calling instructions. The knowledge is just... there.

| What the IDE does | What the agent sees |
|-------------------|-------------------|
| Calls `resources/list` → gets known workspaces | *(nothing, this is invisible)* |
| Calls `resources/read` for current workspace | Agent's context now includes all entities, facts, and relationships from past conversations |

### Tools (agent calls on demand)

### `search_memory`

Search the knowledge graph for entities (files, functions, libraries, errors, decisions, patterns). Use this to recall past work, decisions, and context from previous conversations across all workspaces.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | Yes | Entity name or partial name (e.g. `"auth.ts"`, `"JWT"`, `"LoginService"`) |
| `type` | No | Filter by entity type: `file`, `function`, `class`, `service`, `library`, `pattern`, `error`, `decision`, `config`, `endpoint`, `test` |
| `workspace` | No | Filter to a specific workspace path |
| `depth` | No | Graph traversal depth (default: 2) |
| `limit` | No | Max results (default: 20) |

### `get_workspace_context`

Get all known entities, relationships, and facts for a workspace. Use this at the start of a conversation to load relevant context from past work.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workspace` | Yes | Workspace path to get context for |
| `limit` | No | Max entities to return (default: 200, override with `CONTEXTFORGE_CONTEXT_LIMIT`) |

### `save_conversation`

Save a completed conversation. Extracts entities, relationships, and facts into the knowledge graph. Raw text is discarded after extraction. Call this when a meaningful conversation ends.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workspace` | Yes | Workspace path where the conversation took place |
| `title` | No | Short title summarizing the conversation |
| `messages` | Yes | Array of `{role, content}` messages |

### `add_fact`

Store a specific fact about an entity. Use this to record decisions, patterns, conventions, or other knowledge that should persist.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `entityName` | Yes | Name of the entity (file, function, service, etc.) |
| `entityType` | Yes | Type of entity |
| `workspace` | Yes | Workspace path |
| `key` | Yes | Fact key (e.g. `"pattern"`, `"convention"`, `"reason"`, `"note"`) |
| `value` | Yes | Fact value |

### `get_rally_work_item`

Fetch Rally work item details by FormattedID (for example `US12345` or `TF6789`).

| Parameter | Required | Description |
|-----------|----------|-------------|
| `reference` | Yes | Rally FormattedID to fetch |
| `includeDescription` | No | Include Description/Notes text in the response (default: `false`) |
| `workspaceRef` | No | Optional Rally workspace ref (for example `/workspace/123456789`) |
| `projectRef` | No | Optional Rally project ref (for example `/project/987654321`) |

### `memory_status`

Show how much knowledge is stored across all workspaces. Returns entity, fact, and relation counts per workspace along with timestamp ranges.

*No parameters.*

### `cleanup_memory`

Remove old knowledge by time range. Useful for clearing stale data without deleting everything.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `olderThanDays` | Yes | Delete knowledge older than this many days |
| `workspace` | No | Limit cleanup to a specific workspace (default: all workspaces) |

### `forget_workspace`

Completely remove all knowledge for a workspace — entities, facts, relations, and conversation metadata.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workspace` | Yes | Workspace path to forget |

---

## Knowledge Graph Design

The database uses SQLite with better-sqlite3 (WAL mode), sqlite-vec for vector search, and FTS5 for full-text search. All data is stored in a single file.

### Node types

| Node Table | Properties | Purpose |
|-----------|------------|---------|
| `Entity` | id, type, name, workspace, metadata, createdAt, updatedAt | Files, functions, libraries, errors, decisions, patterns, etc. |
| `Fact` | id, key, value, confidence, sourceConversationId, createdAt, updatedAt | Key-value knowledge about an entity |
| `Conversation` | id, workspace, projectName, ide, title, startedAt, endedAt | Metadata only — no raw text stored |

### Edge types

| Edge Table | From → To | Purpose |
|-----------|-----------|---------|
| `RELATES_TO` | Entity → Entity | Typed relationships (uses, depends_on, tests, caused_by, etc.) |
| `HAS_FACT` | Entity → Fact | Links facts to their entity |
| `MENTIONED_IN` | Entity → Conversation | Tracks which conversations referenced an entity |

### Entity types

`file`, `function`, `class`, `service`, `library`, `pattern`, `error`, `decision`, `config`, `endpoint`, `test`

### Relation types stored in RELATES_TO edges

`uses`, `depends_on`, `modifies`, `tests`, `calls`, `caused_by`, `fixed_by`, `replaces`, `contains`, `implements`, `configures`

### Example queries (Cypher)

```cypher
-- "What do we know about auth.ts?"
MATCH (e:Entity {name: 'auth.ts'})-[r:RELATES_TO]->(related:Entity)
RETURN e, r, related

-- "What libraries does the project use?"
MATCH (e:Entity {type: 'library', workspace: '/my/project'})
RETURN e.name

-- "What errors have been fixed?"
MATCH (err:Entity {type: 'error'})-[r:RELATES_TO {type: 'fixed_by'}]->(fix:Entity)
RETURN err.name, fix.name

-- "Everything about JWT" (2-hop traversal)
MATCH (e:Entity)-[*1..2]-(related:Entity)
WHERE e.name CONTAINS 'JWT'
RETURN e, related
```

### Why graph over flat storage?

The agent doesn't need to use the same words the user used. The graph stores **entities and relationships**, not text blobs:

```
User says: "fix login bug"
                 │
Graph resolves:  "login" → login.ts → auth.ts → JWT expiry bug → fix applied
                 (traverses relationships, not keyword matching)
```

No full-text search index needed. No embedding model needed. Just graph traversal.

#### Query resolution — how `search_memory` finds the right entity

When the user asks *"Why did we choose JWT?"*, here's the exact code path that resolves the query to a graph answer:

```
┌─────────────────────────────────────┐
│  1. User asks:                      │
│     "Why did we choose JWT?"        │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  2. Agent parses intent             │
│     Keyword: JWT                    │
│     Intent: decision / reason       │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  3. Agent calls search_memory       │
│     query='JWT', depth=2, limit=20  │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  4. mcp.ts search_memory handler    │
│     Builds GraphQuery:              │
│     entityName = 'JWT'              │
└──────────────┬──────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────┐
│  database.ts → query()                                   │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Step 1: Find root entities                        │  │
│  │  MATCH (e:Entity)                                  │  │
│  │  WHERE e.name CONTAINS 'JWT'                       │  │
│  │  ORDER BY e.updatedAt DESC                         │  │
│  │  LIMIT 20                                          │  │
│  │                                                    │  │
│  │  Matches:                                          │  │
│  │    [library]  JWT                                  │  │
│  │    [decision] JWT instead of sessions              │  │
│  │    [error]    JWT expiry bug                       │  │
│  └────────────────┬───────────────────────────────────┘  │
│                   │                                      │
│                   ▼                                      │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Step 2: Walk relationships (depth=2)              │  │
│  │  For each root entity:                             │  │
│  │  MATCH (a)-[r:RELATES_TO*1..2]->(b)               │  │
│  │  WHERE a.id = rootId                               │  │
│  │                                                    │  │
│  │  Discovers connected entities:                     │  │
│  │    auth.ts, jsonwebtoken, login.ts,                │  │
│  │    auth.test.ts ...                                │  │
│  └────────────────┬───────────────────────────────────┘  │
│                   │                                      │
│                   ▼                                      │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Step 3: Get direct relations                      │  │
│  │  Between all found entity IDs:                     │  │
│  │  MATCH (a)-[r:RELATES_TO]->(b)                     │  │
│  │                                                    │  │
│  │    auth.ts      --uses-->       JWT                │  │
│  │    auth.test.ts --tests-->      auth.ts            │  │
│  │    error        --caused_by-->  auth.ts            │  │
│  └────────────────┬───────────────────────────────────┘  │
│                   │                                      │
│                   ▼                                      │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Step 4: Get facts                                 │  │
│  │  For each entity ID:                               │  │
│  │  MATCH (e)-[:HAS_FACT]->(f)                        │  │
│  │                                                    │  │
│  │  decision entity →                                 │  │
│  │    key   = 'reason'                                │  │
│  │    value = 'scales better than sessions'           │  │
│  └────────────────┬───────────────────────────────────┘  │
└───────────────────┼──────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────┐
│  5. mcp.ts formats GraphResult      │
│     into text response:             │
│                                     │
│  [library] JWT (/my/project)        │
│  [decision] JWT instead of sessions │
│    reason: scales better            │
│                                     │
│  Relationships:                     │
│    auth.ts --uses--> JWT            │
│    auth.test.ts --tests--> auth.ts  │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  6. Agent synthesizes answer:       │
│     "We chose JWT over sessions     │
│      because it scales better.      │
│      It's used in auth.ts."         │
└─────────────────────────────────────┘
```

If no entities match "JWT" in Step 1, the agent gets `No entities found matching "JWT"` and responds that it has no record of that decision.

**Key details:**

1. **Substring matching** — the query uses `e.name CONTAINS 'JWT'`, not semantic search. The entity name must literally contain the search term.
2. **No ranking** — all matching entities are returned sorted by `updatedAt DESC`. A `[decision]` entity with the "reason" fact might appear alongside `[file]` and `[library]` entities.
3. **Graph traversal** — the 2-hop walk from root entities pulls in connected files, libraries, and errors, giving the agent a subgraph of related context.
4. **Agent synthesis** — the MCP server returns raw graph data. The agent (LLM) is responsible for picking the relevant pieces and forming a coherent answer.

---

## Extraction Engine

The `Extractor` class uses **rule-based pattern matching** — no LLM, no API keys, no internet connection required.

### What it extracts

| Category | How it works |
|----------|-------------|
| **File references** | Regex matching file paths with known extensions (`.ts`, `.py`, `.java`, `.go`, etc.) |
| **Library imports** | Matches `import ... from 'x'`, `require('x')`, Python `import x` patterns |
| **Function/class names** | Matches `function`, `class`, arrow function, method definition patterns |
| **Error patterns** | Matches `Error:`, `Exception:`, `ENOENT`, `TypeError`, `Cannot find`, etc. |
| **Decisions** | Matches "I'll use X because Y", "X instead of Y", "we should X" patterns |

### How relations are built

| Relation | Detection method |
|----------|-----------------|
| File → uses → Library | Both mentioned within 500 chars of each other |
| TestFile → tests → SourceFile | File name contains `.test.` or `.spec.` + matching source file found |
| Error → caused_by → File | Error and file mentioned within 500 chars |
| File → contains → Function | Function and file mentioned within 500 chars |

### Deduplication

- Entities are keyed by `type + name + workspace` — same entity is updated, not duplicated
- Relations are keyed by `source + target + type` — existing relations get their context updated
- Facts are keyed by `entity + key` — new values overwrite old ones with updated confidence scores

---

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXTFORGE_DB_PATH` | `~/.contextforge/contextforge.db` | Override database path |
| `CONTEXTFORGE_CONTEXT_LIMIT` | `500` | Max entities returned by `get_workspace_context` and the resource template |

### External sources (Rally, GitHub, Knowledge Hub)

ContextForge is a **local memory** tool only — it does not connect to Rally, GitHub, or the Knowledge Hub itself. Those are separate MCP servers the agent connects to directly, each added as its own entry in VS Code's MCP config. See the "Connect the other MCP sources" step in [SETUP-MAC.md](SETUP-MAC.md) / [SETUP-WINDOWS.md](SETUP-WINDOWS.md). Rally is used **read-only** (lookup/search/hierarchy).

---

## Data Storage

All data is stored locally:

```
~/.contextforge/
├── contextforge              # MCP server binary
├── contextforge.db                 # SQLite database (all workspaces, all IDEs)
├── models/                   # ONNX embedding model (optional, for vector search)
│   └── Xenova/all-MiniLM-L6-v2/
├── inbox/                    # Conversations queued by capture extensions
│   ├── <session-id>.json     # Pending conversations (processed on next MCP call)
│   └── .processed            # Log of already-processed session IDs
└── node_modules/             # Native addons
    └── better-sqlite3/       # SQLite native binding

# Agent instructions (VS Code / Cursor)
~/Library/Application Support/Code/User/prompts/
└── contextforge.instructions.md   # Tells agents to use memory tools automatically

# MCP config (VS Code / Cursor)
~/Library/Application Support/Code/User/mcp.json
```

### Size

- Binary + native addon: **~69 MB**
- Typical database size: **1-10 MB** for hundreds of conversations
- Compare: raw conversation storage would be **100-1000 MB** for the same data

### Backup

```bash
# Simply copy the database file
cp ~/.contextforge/contextforge.db ~/backup/contextforge.db
```

### Reset

```bash
# Delete the database and start fresh
rm -rf ~/.contextforge/contextforge.db
# The next MCP tool call will create a new empty database
```

---

## Project Structure

```
agent-plugin-optimize-prompt-history/
├── package.json                         # Root workspace config
├── tsconfig.base.json                   # Shared TypeScript config
├── packages/
│   ├── core/                            # MCP server + graph engine
│   │   ├── src/
│   │   │   ├── index.ts                 # Public API exports
│   │   │   ├── models.ts               # TypeScript types (Entity, Relation, Fact, etc.)
│   │   │   ├── schema.ts               # SQLite schema initialization (tables, indexes, FTS5, vec0)
│   │   │   ├── database.ts             # MemoryDatabase — SQLite wrapper with graph-like queries
│   │   │   ├── extractor.ts            # Rule-based knowledge extraction
│   │   │   ├── mcp.ts                  # MCP stdio server (entry point for binary)
│   │   │   └── __tests__/
│   │   │       └── extractor.test.ts   # Unit tests for extraction (7 tests)
│   │   ├── build.js                     # Build pipeline (esbuild → obfuscate → pkg → release)
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── vscode-extension/                # VS Code capture extension
│   │   ├── src/
│   │   │   ├── extension.ts             # Main entry point, command registration
│   │   │   ├── capture.ts              # Chat session file watcher + debounced capture
│   │   │   ├── sessionParser.ts        # JSONL event log parser for Copilot Chat sessions
│   │   │   ├── chatParticipant.ts      # @memory chat participant (manual save/search/status)
│   │   │   ├── inbox.ts               # Writes to ~/.contextforge/inbox/ queue
│   │   │   └── statusBar.ts           # Status bar integration
│   │   └── package.json                 # Extension manifest with contributions
```

---

## Tech Stack

| Component | Technology | License |
|-----------|-----------|---------|
| Database | [SQLite](https://sqlite.org/) (better-sqlite3 + sqlite-vec + FTS5) | MIT / Public Domain |
| MCP protocol | [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | MIT |
| Bundler | esbuild | MIT |
| Binary packaging | @yao-pkg/pkg | MIT |
| Code protection | javascript-obfuscator | BSD-2 |
| Monorepo | npm workspaces | — |

Everything runs **100% locally**. No cloud services, no API keys, no telemetry, no internet required.

---

## Why ContextForge vs Native Copilot Chat?

| Capability | Copilot Native | ContextForge |
|---|---|---|
| Search current workspace files | ✅ | ✅ |
| Remember decisions across conversations | ❌ (forgets on close) | ✅ |
| Recall "why did we choose X?" weeks later | ❌ | ✅ |
| Headless agents (no IDE) get memory | ❌ | ✅ |
| Per-agent isolated memory (test ≠ dev) | ❌ | ✅ |
| Works with any LLM (Claude, GPT, Llama) | ❌ (Copilot only) | ✅ |
| Time-based queries ("what broke last week?") | ❌ | ✅ |
| Survives machine rebuild (backup/restore) | ❌ | ✅ |

### Demo Scenarios

1. **Close VS Code, reopen, ask "what was the last decision we made?"** — Copilot draws a blank, ContextForge answers immediately.

2. **Spin up a headless test agent** — it already knows the codebase conventions from past runs without re-reading everything.

3. **Ask "what errors have we hit in this project?"** — ContextForge recalls the full history; Copilot only knows what's in the current code/logs.

4. **Two agents, same repo, different roles** — show test-agent has zero knowledge of developer-agent's shortcuts/biases.

### The One-Liner Pitch

> Copilot searches your **code**. ContextForge searches your **decisions** — across sessions, agents, and time.

The workspace search Copilot does is just grepping files. ContextForge stores the *reasoning* and *context* that isn't in any file — architecture decisions, past errors, why something was done a certain way.

---

## License

Copyright 2026 Vikas Rai

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full license text.
