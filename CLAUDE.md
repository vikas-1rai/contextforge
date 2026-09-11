# ContextForge Agent Memory

When working in this repository, use the ContextForge MCP server for persistent memory.

## Start of a session

- Call `get_workspace_context` with the current workspace path before other work.
- If no context is found, call `memory_status`, then `search_memory` using the user's first message.

## During work

- Call `search_memory` when recalling past decisions, errors, patterns, or prior work.
- Call `add_fact` immediately for decisions, conventions, diagnosed bugs, significant file changes, and plans.
- Do not persist Jira or Rally results unless the user explicitly asks to save them.

## End of meaningful work

- Call `save_conversation` with the workspace path, a short title, and the conversation messages.

## MCP setup

Claude Code must also have ContextForge registered as an MCP server. From the repository root, use:

```bash
claude mcp add --transport stdio --scope project contextforge -- /Users/<username>/.contextforge/contextforge
```

For a source checkout, use an absolute Node executable and `packages/core/dist/server/mcp.js` instead. Set `CONTEXTFORGE_MODEL_DIR` to `packages/core/release/models` to enable semantic search when the model is not bundled beside the server.