# ContextForge Setup — macOS

The single, complete setup guide for macOS. ContextForge stores its knowledge graph **locally** on your machine in a single SQLite file (`~/.contextforge/contextforge.db`). There is no central server and nothing is uploaded — your memory stays on your Mac.

---

## Prerequisites

- **macOS 12+** (Intel or Apple Silicon)
- **VS Code** installed
- **Node.js 18+** (check: `node --version`)

---

## Installation

### Step 1: Copy the binary

From the person sharing ContextForge with you, get the `release/` folder. Then:

```bash
mkdir -p ~/.contextforge
cp -r release/* ~/.contextforge/
chmod +x ~/.contextforge/contextforge
```

Verify the binary exists:

```bash
ls -lh ~/.contextforge/contextforge
```

You should see a 45–50MB executable.

---

### Step 2: Configure MCP in VS Code

1. **Open MCP configuration**
   - Press `Cmd+Shift+P`
   - Type `MCP: Open User Configuration` (or `MCP: Open User Settings`)
   - Select the result

2. **Add the ContextForge server** to the `servers` section (replace `<username>` with your macOS username — check with `whoami`):

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

3. **Save the file** — VS Code auto-reloads the MCP connection.

---

### Step 3: Add agent instructions

This tells the Copilot agent to automatically use ContextForge's memory tools.

1. **Create the instructions file**

   ```bash
   mkdir -p ~/Library/Application\ Support/Code/User/prompts/
  touch ~/Library/Application\ Support/Code/User/prompts/contextforge.instructions.md
  open ~/Library/Application\ Support/Code/User/prompts/contextforge.instructions.md
   ```

2. **Paste this content and save:**

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

   - When the user asks about past work, decisions, or patterns, call `search_memory`.
   - When a notable decision, pattern, or convention is established, call `add_fact` to persist it immediately.
   - If the user explicitly asks to save a conversation, immediately call `save_conversation` with the full messages and workspace path.

   ## At the end of a meaningful conversation

   - When significant work was done (code changes, decisions, bug fixes, new patterns), call `save_conversation` with the workspace path and messages.
   - Skip this for trivial questions or one-off lookups.

   ## Tool summary

   | Tool | When to use |
   |------|-------------|
   | `get_workspace_context` | Start of conversation — load past knowledge |
   | `search_memory` | Recall past work, decisions, errors, patterns |
   | `add_fact` | Persist a decision, convention, or insight immediately |
   | `save_conversation` | End of meaningful conversation, or when user explicitly asks to save |
   | `memory_status` | Check how much is stored, which workspaces have data |
   | `cleanup_memory` | Remove old knowledge by time range |
   | `forget_workspace` | Remove all knowledge for a workspace |
   ```

---

### Step 4: (Optional) Global CLI access

Add the binary to your PATH so you can run `contextforge` from any terminal:

```bash
echo 'export PATH="$HOME/.contextforge:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Now you can run:

```bash
contextforge status
contextforge search --query "auth"
```

If you skip this step, use the full path `~/.contextforge/contextforge` instead.

---

## Verification

1. **Restart VS Code** completely (close and reopen).
2. Open any folder, then open the Chat panel (`Cmd+I`).
3. Ask Copilot a question about your workspace (e.g. "What files are in this project?"). It should call `get_workspace_context` automatically — check the "Tool Use" section in chat.
4. Confirm the database was created:

   ```bash
  ls -lh ~/.contextforge/contextforge.db
   ```

---

## Step 5 — (Optional) Connect the other MCP sources: KH, Rally, GitHub, Jira

ContextForge is your **memory**. The agent can also pull from other sources, each configured as its **own MCP server** in the same VS Code MCP config from Step 2. Add whichever you need alongside `contextforge` in the `servers` object. If you skip any, nothing breaks — the agent just uses the sources that are present.

```json
{
  "servers": {
    "contextforge": {
      "command": "/Users/<username>/.contextforge/contextforge",
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

---

## (Optional) Back up your knowledge graph

Your entire memory is a single SQLite file: `~/.contextforge/contextforge.db`. A daily backup to a synced folder (OneDrive, iCloud, Dropbox) protects against disk loss and lets you roll back.

A ready-to-use script ships in the repo: `scripts/contextforge-backup.sh`. It runs a safe online backup, verifies integrity, writes a dated file, and rotates out backups older than 7 days.

```bash
# Pick your destination (replace with your real location)
export CONTEXTFORGE_BACKUP_DIR="$HOME/Library/CloudStorage/OneDrive-<YourOrg>/Documents/contextforge-backups"

# Run it once to test
bash ~/src/contextforge/scripts/contextforge-backup.sh
ls -la "$CONTEXTFORGE_BACKUP_DIR"
```

To restore, stop the MCP server and copy a chosen backup over the live DB:

```bash
cp "$CONTEXTFORGE_BACKUP_DIR/contextforge-2026-08-17.db" ~/.contextforge/contextforge.db
```

---

## Troubleshooting

**"MCP: contextforge not found" / "Command failed"** — Check your username and the binary path:

```bash
whoami
ls -lh ~/.contextforge/contextforge
```

Update the `command` path in your MCP config accordingly.

**MCP connection keeps disconnecting** — Fully close VS Code, wait 2 seconds, reopen, and start a new chat.

**Knowledge graph not growing** — Make sure the `contextforge.instructions.md` file from Step 3 exists. Without it, Copilot won't call the persistence tools automatically.

**Reset / start fresh** — Delete the database; it is recreated on your next conversation:

```bash
rm ~/.contextforge/contextforge.db
```

**"A float32 tensor's data must be type of Float32Array"** — A pre-existing ONNX runtime issue affecting only semantic similarity search. Core functionality still works.

---

## Next steps

- Start a conversation with Copilot about your project — it will remember decisions, files, and patterns automatically.
- In future conversations, ask "What did we decide about auth?" and it will search your knowledge graph.
- See the [README](README.md) for architecture details.
