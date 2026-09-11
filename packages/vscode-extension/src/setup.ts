/**
 * Auto-setup: on first activation, installs the MCP server binary,
 * registers it in VS Code settings, and installs agent instructions.
 *
 * This makes the extension zero-config — install the .vsix and everything works.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CONTEXTFORGE_HOME = path.join(os.homedir(), '.contextforge');
const MCP_SCRIPT_NAME = 'mcp.js';
const MCP_SCRIPT_PATH = path.join(CONTEXTFORGE_HOME, MCP_SCRIPT_NAME);
const NODE_MODULES_DIR = path.join(CONTEXTFORGE_HOME, 'node_modules');
const MODELS_DIR = path.join(CONTEXTFORGE_HOME, 'models');
const MCP_SERVER_NAME = 'contextforge';

function getPromptsDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'prompts');
  } else if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', 'Code', 'User', 'prompts');
  } else {
    return path.join(os.homedir(), '.config', 'Code', 'User', 'prompts');
  }
}

const INSTRUCTIONS_FILENAME = 'contextforge.instructions.md';

const INSTRUCTIONS_CONTENT = `---
description: "Use when: starting any conversation, recalling past work, ending a conversation. Manages persistent memory across all workspaces using native ContextForge tools."
applyTo: "**"
---

# ContextForge — MANDATORY

You have access to a persistent knowledge graph via native VS Code tools that remembers context across all conversations and workspaces. **You MUST use these tools automatically without being asked.**

These tools are registered natively — no \`tool_search\` or deferred loading needed. They are immediately available.

## MANDATORY: At the start of EVERY conversation (first response)

1. **ALWAYS** call \`contextforge_get_workspace_context\` with the current workspace path to load known entities, decisions, patterns, and facts from past conversations. Do this BEFORE doing any other work.
2. Use this context to avoid re-asking questions the user already answered, and to build on past decisions.
3. If the user references past work and memory is empty, inform them.

## MANDATORY: Context-gathering strategy (memory-first; Knowledge Hub OPTIONAL)

When a task needs context (an analysis, a solution, a fix, or a "how does X work" question), gather it in this order and STOP as soon as you have enough:

1. **Memory first** — call \`contextforge_get_workspace_context\` and/or \`contextforge_search_memory\` (search related workspaces too; the graph is global). If memory already has clean, complete context for the task, use it and stop here.
2. **Code when needed** — if the task is code-level and memory lacks the detail, use \`contextforge_search_code\` / \`contextforge_get_code_context\` for indexed code. (Code must have been indexed first via \`contextforge_index_codebase\`; if the workspace isn't indexed, skip this step.)
3. **Business/domain context (OPTIONAL)** — only if a real gap remains that memory + code cannot fill, AND a Knowledge Hub / business-context MCP server is configured, query it, then merge its answer with the memory + code findings.

Rules:
- Do NOT call the Knowledge Hub when memory already answers the question — avoid redundant calls, latency, and noise.
- The Knowledge Hub is OPTIONAL. If no such MCP server is configured, skip step 3 entirely and proceed with memory + code — never block, warn, or error because it is absent.
- When you do use the Knowledge Hub, briefly state which gap memory/code did not cover.

## MANDATORY: During the conversation — persist facts IN REAL TIME

\`contextforge_add_fact\` is the PRIMARY persistence mechanism. Call it **immediately** whenever ANY of these occur:

### Decisions & Preferences
- A decision is made (naming, architecture, tool choice, rename, refactor plan)
- A pattern or convention is established
- The user states a preference
- A bug is diagnosed and fixed

### File Changes
- A file is created → store entityType=file, key="created", value=description of what it does
- A file is renamed → store entityType=file, key="renamed", value="old_name → new_name, reason"
- A file is significantly modified → store entityType=file, key="modified", value=summary of what changed and why
- A file is deleted → store entityType=file, key="deleted", value="reason for deletion"

### Plans & Tasks
- When a multi-step plan or todo list is created → store entityType=decision, key="plan", value=full summary of the plan with all steps
- When a plan step is completed → store entityType=decision, key="plan-progress", value="step X completed: description"
- When a plan changes or is revised → store entityType=decision, key="plan-revised", value=updated summary with reason for change
- When a task is blocked or fails → store entityType=error, key="blocker", value=description of what failed and why

### Rules
- Do NOT wait or batch. Persist facts **the moment they happen**.
- Use descriptive values — include context, reasoning, file paths, and relationships.
- When the user asks about past work, decisions, or patterns, call \`contextforge_search_memory\` to find relevant entities.

## Tool signatures — EXACT parameters (do NOT guess parameter names)

### \`contextforge_add_fact\` — the primary persistence tool
Required: \`entityName\`, \`entityType\`, \`workspace\`, \`key\`, \`value\` (ALL required).
- \`entityName\` (string): the thing the fact is about (file, service, decision, etc.)
- \`entityType\` (string, ENUM — exactly one of): \`file | function | class | service | library | pattern | error | decision | config | endpoint | test | ticket\`
- \`workspace\` (string): absolute workspace path
- \`key\` (string): fact key, e.g. \`decision\`, \`pattern\`, \`reason\`, \`created\`, \`modified\`, \`plan\`, \`blocker\`
- \`value\` (string): fact content (include context + reasoning)

⚠️ There is NO \`fact\` param and NO \`type\` param. Omitting \`entityType\` fails with \`NOT NULL constraint failed: entities.type\`.

### \`contextforge_get_workspace_context\`
Required: \`workspace\`. Optional: \`limit\` (see table below).

### \`contextforge_search_memory\`
Required: \`query\`. Optional: \`type\` (same enum as \`entityType\`), \`workspace\`, \`depth\` (default 2), \`limit\` (default 20).

### \`contextforge_save_conversation\`
Params: \`workspace\`, \`title\`, \`messages\` (array of \`{ role, content }\`, role ∈ \`user|assistant|system|tool\`).

### \`contextforge_memory_status\`
No parameters.

## Tool summary

| Tool | When to use |
|------|-------------|
| \`contextforge_get_workspace_context\` | **ALWAYS** at start of conversation — load past knowledge. Pass \`limit\` based on your context capacity (see below). |
| \`contextforge_search_memory\` | Recall past work, decisions, errors, patterns |
| \`contextforge_add_fact\` | **IMMEDIATELY** when any decision/change/plan/file-edit occurs — this is the primary tool |
| \`contextforge_save_conversation\` | Optionally at end if broad relationship extraction is useful |
| \`contextforge_memory_status\` | Check how much is stored, which workspaces have data |
| \`contextforge_cleanup_memory\` | Remove old knowledge by time range (optionally per workspace) |
| \`contextforge_forget_workspace\` | Completely remove all knowledge for a workspace |

## Context limit — choose based on your model

When calling \`contextforge_get_workspace_context\`, pass a \`limit\` appropriate for your context window:

| Context window | Recommended limit | Approx tokens | Latency (large DB) |
|---------------|-------------------|---------------|--------------------|
| 8K–32K        | 200               | ~5K tokens    | <250ms             |
| 128K          | 500 (default)     | ~12K tokens   | <600ms             |
| 200K+         | 1000              | ~25K tokens   | <1.8s              |

If no \`limit\` is passed, the server default (500) is used. **Do NOT pass limit >1000** — at 3000 entities the query can take 10-12 seconds on large databases. Instead, use \`search_memory\` for targeted recall when you need more context than the default provides.
`;

/**
 * Run full setup: extract binary, register MCP, install instructions.
 * Skips steps that are already done (idempotent).
 */
export async function ensureSetup(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const extensionVersion = context.extension.packageJSON.version as string;
  const versionFile = path.join(CONTEXTFORGE_HOME, '.version');
  const installedVersion = fs.existsSync(versionFile)
    ? fs.readFileSync(versionFile, 'utf8').trim()
    : '';
  const isUpgrade = installedVersion !== extensionVersion;

  const needsBinary = await ensureBinary(context, outputChannel);
  const needsMcp = await ensureMcpRegistration(outputChannel, isUpgrade);
  const needsInstructions = await ensureInstructions(outputChannel, isUpgrade);

  if (needsBinary || needsMcp || needsInstructions) {
    const action = installedVersion ? `updated (${installedVersion} → ${extensionVersion})` : 'installed';
    outputChannel.appendLine(`[setup] Setup ${action} successfully`);
    vscode.window.showInformationMessage(
      `ContextForge: Setup ${action}. MCP server and instructions ready.`,
    );
  }
}

/**
 * Extract the bundled MCP server script + native modules + model to ~/.contextforge/
 */
async function ensureBinary(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): Promise<boolean> {
  const bundledServerDir = path.join(context.extensionPath, 'server');

  // Check if already installed and same version
  const versionFile = path.join(CONTEXTFORGE_HOME, '.version');
  const extensionVersion = context.extension.packageJSON.version as string;

  if (fs.existsSync(MCP_SCRIPT_PATH) && fs.existsSync(versionFile)) {
    const installedVersion = fs.readFileSync(versionFile, 'utf8').trim();
    if (installedVersion === extensionVersion) {
      outputChannel.appendLine('[setup] MCP server already installed and up to date');
      return false;
    }
  }

  outputChannel.appendLine('[setup] Installing MCP server...');
  fs.mkdirSync(CONTEXTFORGE_HOME, { recursive: true });

  // Copy mcp.js bundle
  const srcScript = path.join(bundledServerDir, MCP_SCRIPT_NAME);
  if (!fs.existsSync(srcScript)) {
    outputChannel.appendLine(`[setup] ERROR: Bundled mcp.js not found at ${srcScript}`);
    vscode.window.showErrorMessage(
      'ContextForge: Bundled server script not found. Extension may be corrupted.',
    );
    return false;
  }

  fs.copyFileSync(srcScript, MCP_SCRIPT_PATH);

  // Copy node_modules (native addons)
  const srcModules = path.join(bundledServerDir, 'node_modules');
  if (fs.existsSync(srcModules)) {
    copyDirSync(srcModules, NODE_MODULES_DIR);
  }

  // Copy model files
  const srcModels = path.join(bundledServerDir, 'models');
  if (fs.existsSync(srcModels)) {
    copyDirSync(srcModels, MODELS_DIR);
  }

  // Write version marker
  fs.writeFileSync(versionFile, extensionVersion);

  outputChannel.appendLine(`[setup] MCP server installed to ${MCP_SCRIPT_PATH}`);
  return true;
}

/**
 * Register the MCP server in VS Code user settings.
 */
async function ensureMcpRegistration(outputChannel: vscode.OutputChannel, forceUpdate = false): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('mcp');
  const servers = config.get<Record<string, unknown>>('servers') || {};

  if (servers[MCP_SERVER_NAME] && !forceUpdate) {
    outputChannel.appendLine('[setup] MCP server already registered in settings');
    return false;
  }

  const updatedServers = {
    ...servers,
    [MCP_SERVER_NAME]: {
      command: 'node',
      args: [MCP_SCRIPT_PATH],
      type: 'stdio',
      env: {
        CONTEXTFORGE_DB_PATH: path.join(CONTEXTFORGE_HOME, 'contextforge.db'),
        CONTEXTFORGE_CONTEXT_LIMIT: '500',
      },
    },
  };

  await config.update('servers', updatedServers, vscode.ConfigurationTarget.Global);
  outputChannel.appendLine(`[setup] MCP server ${forceUpdate ? 'updated' : 'registered'} in VS Code user settings`);
  return true;
}

/**
 * Install the agent instructions file to the VS Code prompts directory.
 */
async function ensureInstructions(outputChannel: vscode.OutputChannel, forceUpdate = false): Promise<boolean> {
  const promptsDir = getPromptsDir();
  const instructionsPath = path.join(promptsDir, INSTRUCTIONS_FILENAME);

  if (fs.existsSync(instructionsPath) && !forceUpdate) {
    outputChannel.appendLine('[setup] Instructions file already exists');
    return false;
  }

  fs.mkdirSync(promptsDir, { recursive: true });
  fs.writeFileSync(instructionsPath, INSTRUCTIONS_CONTENT);
  outputChannel.appendLine(`[setup] Instructions ${forceUpdate ? 'updated' : 'installed'} at ${instructionsPath}`);
  return true;
}

/**
 * Recursively copy a directory.
 */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
