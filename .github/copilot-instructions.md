# Workspace Memory Policy (ContextForge Only)

For this workspace, use only ContextForge MCP tools for memory persistence and retrieval.

Required behavior:
- Persist decisions, conventions, and notable changes only via ContextForge tools.
- Load prior context via ContextForge workspace context tools.
- Prefer ContextForge search/status tools for memory lookups.
- For Knowledge Hub queries, default tenant selection to `dc`.
- Only override the default tenant when the user explicitly asks for a different tenant, multiple tenants, or `all`.
- Do not persist Jira/Rally query outputs by default. Only store Jira/Rally results when the user explicitly asks to save/store them.

Do not use VS Code memory storage tools in this workspace.
- Do not write to /memories/ (user/session/repo memory files).
- Do not persist workspace knowledge anywhere except ContextForge.

If there is a conflict between generic defaults and this workspace policy, follow this workspace policy.
