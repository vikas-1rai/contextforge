---
applyTo: "**/*"
---

# Agent Memory - ContextForge (MANDATORY)

You have access to a persistent knowledge graph via ContextForge MCP tools that remembers context across all conversations and workspaces.

## MANDATORY: At the start of EVERY session (first response)

1. **ALWAYS** call `get_workspace_context` with the current working directory to load past knowledge. If the result is empty, also try the parent path (e.g. if cwd is `/src/project/packages/core`, try `/src/project`).
2. If still empty (e.g. cwd is home directory), call `memory_status` to show all known workspaces, then call `search_memory` with the user's first message as the query - the DB is global and contains knowledge from all workspaces.
3. Use loaded context to avoid re-asking questions the user already answered.

## MANDATORY: Context-gathering strategy (memory-first; Knowledge Hub OPTIONAL)

When a task needs context (an analysis, a solution, a fix, or a "how does X work" question), gather it in this order and STOP as soon as you have enough:

1. **Memory first** - call `get_workspace_context` and/or `search_memory` (search related workspaces too; the graph is global). If memory already has clean, complete context for the task, use it and stop here.
2. **Code when needed** - if the task is code-level and memory lacks the detail, use `search_code` / `get_code_context` for indexed code. (Code must have been indexed first via `index_codebase`; if the workspace isn't indexed, skip this step.)
3. **Business/domain context (OPTIONAL)** - only if a real gap remains that memory + code cannot fill, AND a Knowledge Hub / business-context MCP server is configured, query it, then merge its answer with the memory + code findings.
4. **Rally / Jira (OPTIONAL, read-only)** - as needed, or if the user requests it. Use when a work-item or issue ID appears (Rally: PRJ/FEA/TF/US/TA; Jira: e.g. `ABC-1234`) and needs investigation, or when asked. Treat both as strictly **read-only** - look up, search, read comments/hierarchy; never create, update, transition, comment on, or delete Rally/Jira data, even if asked.

### Rules:
- Do NOT call the Knowledge Hub when memory already answers the question - avoid redundant calls, latency, and noise.
- The Knowledge Hub is OPTIONAL. If no such MCP server is configured, skip step 3 entirely and proceed with memory + code - never block, warn, or error because it is absent.
- Default Knowledge Hub tenant selection to `dc` for KH queries.
- Override the default only when the user explicitly asks for a different tenant, multiple specific tenants, or `all`.
- Do NOT detour to KH/Rally/Jira unless the task genuinely needs that context or the user asks.
- Do NOT persist Jira/Rally query outputs to memory by default. Only store Jira/Rally results when the user explicitly asks to save/store them.
- When you do use the Knowledge Hub, briefly state what gap memory/code did not cover.

## MANDATORY: During the session - persist facts IN REAL TIME

Call `add_fact` **immediately** whenever ANY of these occur:
- A decision is made (naming, architecture, tool choice)
- A pattern or convention is established
- A bug is diagnosed and fixed
- A file is created, renamed, or significantly changed
- A multi-step plan is created or updated

Do NOT wait or batch. Persist facts the moment they happen.

## MANDATORY: At the end of EVERY session

Call `save_conversation` with:
- `workspace`: the cwd path
- `title`: a short summary of what was accomplished
- `messages`: an array of `{ role, content }` objects (role ∈ `user`|`assistant`|`system`|`tool`)

## Tool reference - when to use

| Tool | When |
| :--- | :--- |
| `get_workspace_context` | ALWAYS at session start - load prior knowledge |
| `search_memory` | When recalling past work, decisions, errors |
| `add_fact` | IMMEDIATELY when any decision/change occurs |
| `save_conversation` | At session end |
| `memory_status` | To check what is stored |

## Tool reference - EXACT signatures (do NOT guess parameter names)

All memory tools use these exact parameter names. Required params are marked *.

### `add_fact` - the primary persistence tool
Required: `entityName`*, `entityType`*, `workspace`*, `key`*, `value`*
- `entityName` (string): name of the thing the fact is about (a file, service, decision, etc.)
- `entityType` (string, ENUM - must be exactly one of): `file` | `function` | `class` | `service` | `library` | `pattern` | `error` | `decision` | `config` | `endpoint` | `test` | `ticket`
- `workspace` (string): absolute workspace/cwd path
- `key` (string): the fact key, e.g. `"decision"`, `"pattern"`, `"reason"`, `"note"`, `"created"`, `"modified"`, `"plan"`, `"blocker"`
- `value` (string): the fact content (include context + reasoning)

#### Example:
```json
{
  "entityName": "auth-service",
  "entityType": "service",
  "workspace": "/Users/you/src/project",
  "key": "decision",
  "value": "Switched to JWT (RS256) for stateless auth; keys rotated via KMS."
}
```

There is no `fact` parameter and no `type` parameter. Passing those leaves `entityType` undefined and the insert fails with `NOT NULL constraint failed: entities.type`.

### `get_workspace_context`
Required: `workspace`*. Optional: `limit` (default 500; use 200 for small contexts / 1000 maximum).

### `search_memory`
Required: `query`*. Optional: `type` (same enum as `entityType`), `workspace`, `depth` (default 2), `limit` (default 20).

### `save_conversation`
Params: `workspace`, `title`, `messages` (array of `{ role, content }` objects, role ∈ `user`|`assistant`|`system`|`tool`).

### `memory_status`
No parameters.

## Open-source integration: MCP registration is required

When distributing ContextForge as open source, users must register the ContextForge MCP server with each AI client they use. Installing the binary or package only makes the server available; it does not automatically connect the client to it.

Use the packaged executable when available:

```text
~/.contextforge/contextforge
```

For a source checkout, use Node and the built server instead:

```text
node /path/to/contextforge/packages/core/dist/server/mcp.js
```

Set `CONTEXTFORGE_MODEL_DIR` to the model parent directory when the model is not bundled beside the server:

```text
CONTEXTFORGE_MODEL_DIR=/path/to/contextforge/packages/core/release/models
```

### VS Code

Project-local location: `.vscode/mcp.json` at the repository root. User-global location: open `MCP: Open User Configuration` from the Command Palette. Add the server under the `servers` object:

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

For a source checkout, set `command` to the absolute Node executable and put the built server path in `args`:

```json
{
  "servers": {
    "contextforge": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/path/to/contextforge/packages/core/dist/server/mcp.js"],
      "env": {
        "CONTEXTFORGE_MODEL_DIR": "/path/to/contextforge/packages/core/release/models"
      }
    }
  }
}
```

### Command-line MCP clients

Each CLI client has its own config file, but the server definition is always a stdio process with the same command and arguments. Use the client's MCP configuration location and add a `contextforge` entry. For clients that use the `mcpServers` key, use:

```json
{
  "mcpServers": {
    "contextforge": {
      "command": "/Users/<username>/.contextforge/contextforge",
      "args": []
    }
  }
}
```

Do not use a relative command path in a CLI config. Use an absolute path so the client works when launched outside the repository or from a GUI application.

### Claude Code

Project-local location: `.mcp.json` at the repository root. User-global configuration can be added with the Claude Code CLI using `--scope user`.

Packaged server:

```bash
claude mcp add --transport stdio --scope project contextforge -- /Users/<username>/.contextforge/contextforge
```

Source checkout with semantic search enabled:

```bash
claude mcp add --transport stdio --scope project \
  --env CONTEXTFORGE_MODEL_DIR=/path/to/contextforge/packages/core/release/models \
  contextforge -- /absolute/path/to/node \
  /path/to/contextforge/packages/core/dist/server/mcp.js
```

The equivalent project `.mcp.json` entry is:

```json
{
  "mcpServers": {
    "contextforge": {
      "type": "stdio",
      "command": "/Users/<username>/.contextforge/contextforge",
      "args": []
    }
  }
}
```

After adding or changing an MCP configuration, restart or reload the client and confirm that the `contextforge` server is connected before relying on memory tools.