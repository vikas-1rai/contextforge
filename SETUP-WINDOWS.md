# ContextForge Setup — Windows

The single, complete setup guide for Windows x64. ContextForge stores its knowledge graph **locally** on your machine in a single SQLite file (`%USERPROFILE%\.contextforge\contextforge.db`). There is no central server and nothing is uploaded — your memory stays on your machine.


## Prerequisites



## Installation

### Step 1: Copy the release folder

From the person sharing ContextForge with you, get the `release/` folder. Then copy it to your user profile:

```powershell
New-Item -ItemType Directory -Force $env:USERPROFILE\.contextforge | Out-Null
Copy-Item .\release\* -Destination $env:USERPROFILE\.contextforge -Recurse -Force
```

Verify the binary exists:

```powershell
Get-ChildItem $env:USERPROFILE\.contextforge\contextforge.exe
```

If your release uses a different filename, use that exact file in the next step.


### Step 2: Configure MCP in VS Code

1. **Open MCP configuration**
   - Press `Ctrl+Shift+P`
   - Type `MCP: Open User Configuration` (or `MCP: Open User Settings`)
   - Select the result

2. **Add ContextForge server**

   Add this to the `servers` section:

   ```json
   {
     "servers": {
       "contextforge": {
         "command": "C:\\Users\\<username>\\.contextforge\\contextforge.exe",
         "type": "stdio"
       }
     }
   }
   ```

   **Example** (if your username is `alice`):

   ```json
   {
     "servers": {
       "contextforge": {
         "command": "C:\\Users\\alice\\.contextforge\\contextforge.exe",
         "type": "stdio"
       }
     }
   }
   ```

3. **Save the file** — VS Code should reload the MCP connection automatically.


### Step 3: Add agent instructions

This tells the Copilot agent to automatically use ContextForge's memory tools.

1. **Create the instructions file**

   ```powershell
   New-Item -ItemType Directory -Force "$env:APPDATA\Code\User\prompts" | Out-Null
  New-Item -ItemType File -Force "$env:APPDATA\Code\User\prompts\contextforge.instructions.md" | Out-Null
   ```

2. **Open the file in VS Code**

   ```powershell
  code "$env:APPDATA\Code\User\prompts\contextforge.instructions.md"
   ```

3. **Paste this content**

   ```markdown
   ---
  description: "Use when: starting any conversation, recalling past work, ending a conversation. Manages persistent memory across all workspaces using the contextforge MCP tools."
   ---

  # ContextForge

   You have access to a persistent knowledge graph via MCP tools that remembers context across all conversations and workspaces.

   ## At the start of every conversation

   1. Call `get_workspace_context` with the current workspace path to load known entities, decisions, patterns, and facts from past conversations.
   2. Use this context to avoid re-asking questions the user already answered, and to build on past decisions.

   ## Context-gathering strategy (memory-first)

   When a task needs context, gather it in this order and STOP as soon as you have enough. Every source except memory is optional — if one isn't configured, skip it and continue; never block or error because a source is absent.

   1. **Memory first** — call `get_workspace_context` and/or `search_memory` (the graph is global). If memory already has clean, complete context, use it and stop here.
   2. **Open code + indexed code** — use the open editor context, and `search_code` / `get_code_context` for indexed code (index first via `index_codebase`).
  3. **Knowledge Hub (KH)** — for business/domain gaps that memory + code can't fill, query the KH MCP server, then merge the answer. Default tenant selection to `dc` unless the user explicitly asks for a different tenant, multiple tenants, or `all`.
   4. **Rally (read-only)** — when a Rally ID (PRJ/FEA/TF/US/TA) appears in the prompt, memory, code, or KH and needs investigation, use the Rally MCP server to look up items, search, and traverse hierarchy. Treat Rally as strictly read-only — never create, update, or delete Rally data, even if asked.
   5. **GitHub** — to read commits/PRs or to create PRs/issues, use the GitHub MCP server. *(Optional — GitHub Copilot already connects to GitHub natively; only add the MCP server if you need to route through the gateway or expose GitHub to a non-Copilot agent.)*
   6. **Jira (read-only)** — when a Jira key (e.g. `ABC-1234`) appears in the prompt, memory, code, or KH and needs investigation, use the Jira MCP server to look up issues, search, and read comments. Treat Jira as read-only — never create, update, transition, or comment on issues, even if asked.

   Rules:
   - Don't call a downstream source when an upstream one already answers the question — avoid redundant calls and noise.
  - For KH queries, default to tenant `dc` unless the user explicitly asks for different tenant scope.
  - Do not persist Jira/Rally query outputs by default; only store them when the user explicitly asks to save/store.
   - Persist genuinely useful findings back into memory via `add_fact` so future sessions get faster.

   ## During the conversation

   - When the user asks about past work, decisions, or patterns, call `search_memory` to find relevant entities.
   - When a notable decision, pattern, or convention is established, call `add_fact` to persist it immediately.
   - If the user explicitly asks to save a conversation, immediately call `save_conversation` with the full conversation messages and workspace path.

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
   | `save_conversation` | End of meaningful conversation — extract and store knowledge |
   | `memory_status` | Check how much is stored, which workspaces have data |
   | `cleanup_memory` | Remove old knowledge by time range (optionally per workspace) |
   | `forget_workspace` | Completely remove all knowledge for a workspace |
   ```

4. **Save the file** — you're done.


### Step 4: Optional global access

If you want to run ContextForge from any terminal, add it to your PATH:

```powershell
[Environment]::SetEnvironmentVariable(
  "Path",
  $env:Path + ";$env:USERPROFILE\.contextforge",
  "User"
)
```

Open a new terminal after updating PATH.


## Verification

### Check MCP connection

1. **Restart VS Code** completely
2. **Open any folder** in VS Code
3. **Open the Chat panel** (`Ctrl+I`)
4. **Ask Copilot a question about your workspace**
   - Example: "What files are in this project?"
   - Copilot should call `get_workspace_context` automatically

### Check local knowledge graph

Verify the database was created:

```powershell
Get-ChildItem $env:USERPROFILE\.contextforge\contextforge.db
```


## Using ContextForge

### Automatic (recommended)

Once configured, ContextForge runs automatically:

1. Start a conversation with Copilot
2. Copilot calls `get_workspace_context` to load past decisions
3. When you make changes or discuss architecture, Copilot calls `add_fact` to store knowledge
4. When a conversation ends with significant work, Copilot calls `save_conversation` to extract and index knowledge

### Manual (CLI)

```powershell
$env:USERPROFILE\.contextforge\contextforge.exe status
$env:USERPROFILE\.contextforge\contextforge.exe memory_status
$env:USERPROFILE\.contextforge\contextforge.exe search --query "auth"
```


## Step 5 — (Optional) Connect the other MCP sources: KH, Rally, GitHub, Jira

ContextForge is your **memory**. The agent can also pull from other sources, each configured as its **own MCP server** in the same VS Code MCP config from Step 2. Add whichever you need alongside `contextforge` in the `servers` object. If you skip any, nothing breaks — the agent just uses the sources that are present.

```json
{
  "servers": {
    "contextforge": {
      "command": "C:\\Users\\<username>\\.contextforge\\contextforge.exe",
      "type": "stdio"
    },

    "rally": {
      "type": "http",
      "url": "<your Rally MCP URL>",
      "headers": {
        "Authorization": "Bearer <gateway-token>",
        "X-Rally-API-Key": "<your Rally API key>",
        "Accept": "application/json, text/event-stream"
      }
    },

    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer <your GitHub token>"
      }
    },

    "jira-virtual-mcp-server": {
      "type": "http",
      "url": "<your Jira MCP server URL>",
      "headers": {
        "Authorization": "Bearer <your MCP gateway token>",
        "X-Jira-Token": "<your X-Jira-Token>"
      }
    },

    "knowledge-hub": {
      "type": "http",
      "url": "<your Knowledge Hub MCP URL>",
      "headers": {
        "Authorization": "Bearer <your KH token>"
      }
    }
  }
}
```

**What each source is for:**

| Server | Purpose | Notes |
|--------|---------|-------|
| `contextforge` | Persistent memory (store & recall) | Always present |
| `rally` | Work items (PRJ/FEA/TF/US/Task), search, hierarchy | **Read-only** — see below |
| `github` | Read commits/PRs, create PRs and issues | **Optional** — Copilot connects to GitHub natively; add this only for gateway routing or non-Copilot agents |
| `jira-virtual-mcp-server` | Jira issues — lookup, search, comments | **Read-only** by policy; needs a gateway token + `X-Jira-Token` |
| `knowledge-hub` | Business/domain context | Optional |

> **Rally is read-only by policy.** The hosted Rally MCP exposes only read tools (lookup/search/hierarchy). The instruction file (Step 3) tells the agent to treat Rally as read-only and never attempt writes. Do not add any Rally write tool to your agent's allowed set.

Save the file — VS Code reloads the MCP connections automatically. Use the exact URLs, headers, and tokens your team provides for Rally, GitHub, Jira, and KH. **Never commit real tokens** — keep them only in your local MCP config.


## (Optional) Back up your knowledge graph

Your entire memory is a single SQLite file: `%USERPROFILE%\.contextforge\contextforge.db`. The repo ships `scripts/contextforge-backup.sh`, which runs under Git Bash or WSL. Point it at a synced folder and schedule it with Task Scheduler for a daily backup:

```bash
export CONTEXTFORGE_BACKUP_DIR="/c/Users/<username>/OneDrive-<YourOrg>/contextforge-backups"
bash /path/to/contextforge/scripts/contextforge-backup.sh
```

Backups are plain SQLite files. To restore, stop the MCP server and copy a chosen backup over `%USERPROFILE%\.contextforge\contextforge.db`.


## Notes

