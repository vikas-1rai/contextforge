# Architecture Decision Records

This document captures the key design decisions, tradeoffs, and data analysis that shaped the contextforge system.

---

## ADR-1: SQLite over Graph Database (KuzuDB → SQLite Migration)

**Status**: Accepted  
**Date**: April 2026

### Context

We need to store extracted knowledge from AI agent conversations in a way that supports fast traversal, relationship-aware queries, and compact serialization into agent context windows.

Initially built on **KuzuDB** (embedded graph database). Migrated to **SQLite** in April 2026.

### Migration Reason: KuzuDB → SQLite

KuzuDB was archived in October 2025 (no longer maintained). Additionally:
- KuzuDB required a large native addon (`@codebolt/kuzu` ~18MB) with fragile cross-platform builds
- Cypher queries were overkill for our max 2-hop traversal pattern
- SQLite with JOINs achieves the same graph-like queries with better tooling/stability
- sqlite-vec extension adds vector search that KuzuDB didn't support natively

### Options Evaluated

| Option | Pros | Cons |
|--------|------|------|
| **SQLite + sqlite-vec** | Ubiquitous, zero-config, single file, fast reads, WAL mode for concurrent access, vector search via sqlite-vec extension | Relationship traversal via JOINs (acceptable for 2-hop max) |
| **JSON files (document)** | Simplest, no dependencies, human-readable | No query language, O(n) search, no relationship traversal, grows unbounded |
| **Vector DB (embeddings)** | Semantic search, handles fuzzy queries | Requires embedding model (API cost or local model), large storage, slow startup, overkill for structured knowledge |
| **Neo4j (graph)** | Industry standard graph DB, rich Cypher support | Requires server process, heavy (JVM), not embeddable, licensing concerns |

### Decision

**Use SQLite + sqlite-vec + FTS5** as the embedded database.

Previously used KuzuDB (graph), but migrated to SQLite in April 2026 after KuzuDB was archived (Oct 2025). SQLite with JOIN-based graph traversal, FTS5 full-text search, and sqlite-vec for vector similarity search covers all our needs.

### Rationale

1. **Graph-like queries via JOINs**: "What does auth.ts depend on?" is a 2-table JOIN — simple enough for our max 2-hop traversal
2. **Embedded = zero config**: No server to start/manage, no Docker, no ports — just `better-sqlite3`
3. **WAL mode + busy_timeout**: Supports concurrent multi-IDE access without lock conflicts
4. **Vector search**: sqlite-vec extension enables semantic similarity search with ONNX embeddings
5. **FTS5**: Full-text search for entity names and fact values
6. **Apache-2.0 license**: Permissive licensing with explicit patent terms
7. **Single file storage**: `~/.contextforge/contextforge.db` — easy to backup, move, delete
8. **Ubiquitous**: SQLite is the most deployed database in the world — stable, well-tested, will never be abandoned

### Tradeoffs Accepted

- **JOIN-heavy for deep traversal**: 3+ hop queries require multiple JOINs. Acceptable since we cap at 2 hops.
- **Native addon required**: `better-sqlite3` is a platform-specific binary. Users must receive the correct build for their OS/arch. Mitigated by shipping alongside the MCP binary.

### Performance

SQLite approach for "show me everything related to auth.ts within 2 hops":

```
SELECT ... FROM entities e
JOIN relations r1 ON e.id = r1.source_id
JOIN entities e2 ON r1.target_id = e2.id
LEFT JOIN relations r2 ON e2.id = r2.source_id
LEFT JOIN entities e3 ON r2.target_id = e3.id
WHERE e.name = 'auth.ts'
→ <5ms with proper indexes
```

---

## ADR-2: Context Window Budget — Entity Limits and Token Analysis

**Status**: Accepted  
**Date**: April 2026

### Context

The MCP server returns workspace knowledge to agents at the start of every conversation. This consumes context window tokens. We need to set a default entity limit that balances usefulness vs. context cost.

### Token Estimation Model

Based on measurement of actual graph output:
- ~10 tokens per entity (name, type, workspace)
- ~10 tokens per relationship (source → type → target)
- ~15 tokens per fact (entity, key, value)

**Estimated token usage by entity count** (assuming ~3 relationships + ~0.5 facts per entity):

| Entities | Est. Tokens | % of 200K (Claude) | % of 128K (GPT-4o) | % of 1M (GPT-4.1/Gemini) |
|----------|-------------|---------------------|---------------------|---------------------------|
| 50 | ~1,500 | 0.75% | 1.2% | 0.15% |
| 200 | ~6,000 | 3% | 4.7% | 0.6% |
| 500 | ~15,000 | 7.5% | 11.7% | 1.5% |
| 1,000 | ~30,000 | 15% | 23.4% | 3% |

**Key insight**: 50 entities uses less than 1.5% of even the smallest modern context window. We can be generous with the default.

### Recommended Caps by Model Tier

| Model Tier | Context Window | Reasonable Cap | Tokens Used | % of Window |
|------------|---------------|----------------|-------------|-------------|
| Cheap (GPT-4o-mini, Haiku) | 128K | 200–300 | ~6–9K | ~5–7% |
| Standard (GPT-4o, Sonnet) | 128–200K | 500 | ~15K | ~8–12% |
| Large (Claude Opus, GPT-4.1) | 200K–1M | 1,000+ | ~30K | ~3–15% |

### Decision

**Default: 200 entities** (`CONTEXTFORGE_CONTEXT_LIMIT=200`)

### Rationale

- 200 entities ≈ 6K tokens ≈ 3–5% of standard context windows
- Safe for even the cheapest models (128K window)
- Covers most small-to-medium projects entirely
- Users on larger models can override via env var to 500–1,000
- The cost is negligible compared to typical conversation content (code blocks, file contents sent by tools easily consume 20–50K tokens)

### Tradeoffs Accepted

- Large monorepos with 1000+ files will only see the top 200 entities. Mitigation: `search_memory` can find anything regardless of the context limit.
- The limit is a hard cutoff, not ranked. Future improvement: score entities by recency/relevance and return the most useful 200.

---

## ADR-3: Rule-Based Extraction over LLM Extraction

**Status**: Accepted  
**Date**: April 2026

### Context

When a conversation is saved, we need to extract entities (files, functions, libraries, errors, decisions) and relationships from raw chat messages.

### Options Evaluated

| Option | Pros | Cons |
|--------|------|------|
| **LLM extraction** | High accuracy, understands nuance, can extract implicit knowledge | Requires API key, costs money per conversation, adds latency (2-10s), fails offline, model-dependent quality |
| **Rule-based (regex/patterns)** | Instant, free, works offline, deterministic, no API key needed | Misses implicit knowledge, can produce noise (false positives), needs maintenance for new patterns |
| **Hybrid** | Best of both: rules for obvious patterns, LLM for nuanced decisions | Complex, still requires API key for full benefit |

### Decision

**Rule-based extraction only** (no LLM dependency).

### Rationale

1. **Zero cost**: No API calls, no token budget consumed for extraction
2. **Instant**: Extraction happens in <50ms, not 2-10 seconds
3. **Works offline**: No internet connection required
4. **Deterministic**: Same input always produces same output — no model temperature variance
5. **No API key required**: Users don't need to configure anything beyond the binary
6. **Good enough**: File paths, import statements, error messages, and decision patterns are highly structured — regex catches 80%+ of them

### Tradeoffs Accepted

- **Misses implicit knowledge**: "We chose this approach because it scales better" — the decision extractor catches some patterns but not all nuanced reasoning
- **False positives**: Common words that look like entity names may be extracted incorrectly (e.g., `the`, `me`, `connected`). Mitigation: improve patterns over time.
- **No semantic understanding**: Can't infer that "the login bug" refers to `auth.ts`. Mitigation: graph traversal compensates — if both appeared in the same conversation, they're linked.

### What Gets Extracted

| Category | Pattern Examples |
|----------|-----------------|
| Files | `/path/to/file.ts`, `auth.ts`, `package.json` |
| Libraries | `import X from 'Y'`, `require('X')`, `pip install X` |
| Functions | `function handleLogin()`, `class UserService`, `const fn = () =>` |
| Errors | `Error: X`, `TypeError: X`, `ENOENT`, `Cannot find X` |
| Decisions | `I'll use X instead of Y`, `decided to X because Y`, `chose X over Y` |

### Future Option

Add an optional LLM extraction mode behind a flag (`CONTEXTFORGE_LLM_EXTRACT=true`) for users who want higher-quality extraction and have API keys available. This would run as a second pass after rule-based extraction.

---

## ADR-4: Inbox Pattern for Write Decoupling

**Status**: Accepted  
**Date**: April 2026

### Context

The capture extension (VS Code) watches for completed conversations and needs to send them to the MCP server for ingestion. The extension and MCP server run in separate processes.

### Options Evaluated

| Option | Pros | Cons |
|--------|------|------|
| **Direct DB write from extension** | Simplest, immediate | Extension needs better-sqlite3 dependency, double the binary size, DB lock conflicts with MCP server |
| **HTTP API** | Clean separation, standard pattern | Requires running a server, port management, firewall issues |
| **File-based inbox** | No dependencies, no network, no lock conflicts, simple | Slight delay (processed on next MCP call), needs filesystem watching |
| **IPC/Unix socket** | Fast, direct communication | Platform-specific, complex error handling, process lifecycle coupling |

### Decision

**File-based inbox** at `~/.contextforge/inbox/`.

### Rationale

1. **Zero coupling**: Extension writes a JSON file, MCP server reads it later — they never communicate directly
2. **No dependencies**: Extension doesn't need better-sqlite3, network stack, or IPC libraries
3. **Crash resilient**: If the MCP server crashes, inbox files persist and are processed on restart
4. **Debuggable**: You can `ls ~/.contextforge/inbox/` and `cat` the files to see what's queued
5. **Cross-IDE**: The inbox pattern is simple enough to support any future IDE capture extension

### Tradeoffs Accepted

- **Not real-time**: Inbox is processed on MCP server startup and before resource reads, not instantly. Typical delay: seconds to minutes depending on when the next MCP call happens.
- **Filesystem dependency**: Relies on the home directory being writable. Not an issue in practice.
- **No back-pressure**: If the inbox fills up with thousands of files, processing takes longer on the next MCP call. Mitigation: each file is small (~1-5KB) and processing is fast (<100ms per file).

---

## ADR-5: Single Binary Distribution via `pkg`

**Status**: Accepted  
**Date**: April 2026

### Context

The MCP server is a Node.js/TypeScript application. End users need to run it, but we don't want to require Node.js installation.

### Options Evaluated

| Option | Pros | Cons |
|--------|------|------|
| **npm package** | Standard Node.js distribution | Requires Node.js installed, `npm install` knowledge, version conflicts |
| **Docker** | Isolated, reproducible | Heavy (~200MB+), requires Docker, stdio MCP transport doesn't work well in containers |
| **pkg (single binary)** | No runtime needed, single file, just copy and run | Large binary (~49MB), platform-specific builds needed, native addon must be shipped separately |
| **Deno compile** | Single binary, modern runtime | Would require rewriting from Node.js, native addon bindings not straightforward |

### Decision

**Use `pkg`** to compile the Node.js MCP server into a single standalone binary.

### Rationale

1. **Zero prerequisites**: Users don't need Node.js, npm, or any runtime
2. **Simple distribution**: Two files — the binary + the native addon (better-sqlite3)
3. **Familiar install**: `cp contextforge ~/.contextforge/ && chmod +x` — that's it
4. **IDE integration**: MCP config just points to the binary path — no `npx`, no `node`, no shell scripts

### Tradeoffs Accepted

- **Binary size**: ~49MB (includes Node.js runtime). Acceptable for a one-time install.
- **Native addon shipped separately**: `better_sqlite3.node` can't be bundled into the pkg binary. Must be distributed alongside in `node_modules/better-sqlite3/`.
- **Platform-specific**: Must build separately for macOS arm64, macOS x64, Linux x64, Windows x64. Currently only macOS arm64 is built.

---

## ADR-6: Automatic Capture as Primary Write Path

**Status**: Accepted  
**Date**: April 2026

### Context

We have two ways to write conversations to the knowledge graph:
1. **Instruction-driven**: Agent instructions tell the agent to call `save_conversation` at the end of meaningful conversations
2. **Automatic capture**: A VS Code extension watches chat session files and saves them without agent cooperation

### Decision

**Both paths exist, but automatic capture is the recommended primary path.**

### Rationale

- Agents don't always follow instructions — some models ignore `save_conversation` prompts
- Cheaper models (GPT-4o-mini, Haiku) are less reliable at tool calling
- Users shouldn't have to depend on agent behavior for knowledge persistence
- The capture extension is a "set and forget" safety net

### Tradeoffs Accepted

- **Duplicate writes possible**: If both the agent calls `save_conversation` AND the extension captures the same conversation, elements get upserted (not duplicated) thanks to entity deduplication by name+type+workspace
- **Extension is IDE-specific**: Need separate implementations for each IDE
- **Session file format is undocumented**: VS Code's `chatSessions/*.jsonl` format is internal and may change between versions. The parser handles current format but may need updates.

---

## ADR-7: Vector Embeddings for Conversation Summary Search

**Status**: Accepted  
**Date**: April 2026

### Context

The knowledge graph stores entities and facts, but conversations often contain context that doesn't map cleanly to discrete entities — architectural reasoning, tradeoff discussions, debugging narratives. Users need to search for past conversations semantically (e.g., "why did we switch auth providers?").

### Options Evaluated

| Option | Pros | Cons |
|--------|------|------|
| **FTS5 keyword search on summaries** | Fast, no model needed, exact matches | Misses semantic similarity ("auth" won't find "login system"), no fuzzy matching |
| **LLM-based search (API call)** | Highest quality semantic understanding | Requires API key, costs per query, adds latency, fails offline |
| **Local embedding model + vector DB** | Semantic search, works offline, zero cost per query | Requires bundling a model (~30MB), initial load time |
| **Separate vector DB (Qdrant, Chroma)** | Purpose-built for vector search | Another dependency, another process, more complexity |

### Decision

**Use sqlite-vec (vector extension for SQLite) with local ONNX embeddings (all-MiniLM-L6-v2).**

Store vector embeddings of conversation summaries in a `vec0` virtual table within the same SQLite database. Use the bundled offline embedding model for local inference.

### Architecture

```
Conversation saved
  → Summary generated (rule-based extraction of key points)
  → Summary text embedded via all-MiniLM-L6-v2 (384-dim vector)
  → Vector stored in vec_conversations table (sqlite-vec)

Search query
  → Query text embedded via same model
  → Cosine similarity search against vec_conversations
  → Returns top-K matching conversations with summaries
```

### Rationale

1. **Single database file**: Vectors live in the same `contextforge.db` as entities/facts — no separate vector DB process
2. **Offline-first**: Local ONNX model, no API calls, no internet needed
3. **Zero marginal cost**: No per-query charges, embed as many conversations as needed
4. **Semantic matching**: "authentication refactor" finds conversations about "login system redesign"
5. **Small model**: all-MiniLM-L6-v2 is ~30MB, produces 384-dim vectors — good quality/size tradeoff
6. **sqlite-vec**: Maintained extension, licensed under MIT OR Apache-2.0, works with better-sqlite3

### Tradeoffs Accepted

- **Model bundling size**: The offline embedding model adds ~90MB to the package (tokenizer files + ONNX weights). Acceptable for internal distribution.
- **First-run latency**: Model loads in 1-2 seconds on first embedding call. Subsequent calls are fast (~10ms per embedding).
- **384-dim vs higher**: Larger models (768-dim, 1024-dim) would give better accuracy but at 2-4x storage and compute cost. 384-dim is sufficient for our conversation-level granularity.
- **Summary quality limits search quality**: If the extracted summary is poor, semantic search won't find the right conversation. Mitigation: store full conversation titles alongside summaries for keyword fallback.

---

## ADR-8: Single Extension Install (Zero-Config Distribution)

**Status**: Accepted  
**Date**: April 2026

### Context

The system has three components that need to be installed:
1. MCP server binary (`contextforge`)
2. MCP registration in VS Code settings
3. Agent instructions file (`.instructions.md`)

Previously required 3 manual setup steps per user.

### Decision

**Bundle everything inside the VS Code extension (.vsix). On first activation, the extension auto-installs all components.**

### Implementation

1. Extension ships with `server/contextforge` (binary) + `server/node_modules/` (native addons)
2. On activation, `setup.ts` runs:
  - Extracts binary to `~/.contextforge/contextforge`
  - Registers `contextforge` in `mcp.servers` (VS Code user settings)
  - Installs `contextforge.instructions.md` to VS Code prompts directory
3. Version marker (`~/.contextforge/.version`) prevents redundant reinstalls
4. All steps are idempotent — safe to run on every activation

### Distribution

- Internal `.vsix` file distributed during development (not published to the public marketplace)
- Users install via `code --install-extension contextforge-capture-0.1.0.vsix`
- macOS (arm64) only for now

### Tradeoffs Accepted

- **Large extension size (~110 MB)**: Includes the binary + the bundled offline embedding model (all-MiniLM-L6-v2 ONNX). Acceptable for internal distribution.
- **No auto-updates**: Users must manually install new `.vsix` versions. Could add a version check + download later.
- **macOS only**: Cross-platform builds needed for Linux/Windows support in the future.
