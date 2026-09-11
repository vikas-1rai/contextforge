/**
 * Watches VS Code Copilot Chat session files for completed conversations.
 *
 * Session files are stored in:
 *   ~/Library/Application Support/Code/User/workspaceStorage/<workspace-hash>/chatSessions/<session-id>.jsonl
 *
 * The watcher:
 * 1. Finds all chatSessions/ directories
 * 2. Watches for new/modified .jsonl files
 * 3. After a debounce period (session considered "complete"), parses and queues
 * 4. Writes extracted messages to the inbox for MCP server processing
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseSessionFile } from './sessionParser';
import { writeToInbox, isAlreadyProcessed, markProcessed } from './inbox';

// Map of session file path → debounce timer
const pendingCaptures = new Map<string, NodeJS.Timeout>();

// Track which sessions we've already captured (by mtime) to avoid re-processing
const capturedMtimes = new Map<string, number>();

let watchers: vscode.FileSystemWatcher[] = [];
let outputChannel: vscode.OutputChannel;
let paused = false;

export function initCapture(channel: vscode.OutputChannel): void {
  outputChannel = channel;
  setupWatchers();
}

export function setPaused(value: boolean): void {
  paused = value;
}

export function isPaused(): boolean {
  return paused;
}

export function disposeCapture(): void {
  for (const timer of pendingCaptures.values()) {
    clearTimeout(timer);
  }
  pendingCaptures.clear();
  for (const w of watchers) {
    w.dispose();
  }
  watchers = [];
}

function getWorkspaceStorageBase(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage');
  } else if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', 'Code', 'User', 'workspaceStorage');
  } else {
    return path.join(os.homedir(), '.config', 'Code', 'User', 'workspaceStorage');
  }
}

function setupWatchers(): void {
  const wsBase = getWorkspaceStorageBase();
  if (!fs.existsSync(wsBase)) {
    outputChannel.appendLine(`[capture] Workspace storage not found at ${wsBase}`);
    return;
  }

  // Watch for .jsonl files in any chatSessions directory
  const pattern = new vscode.RelativePattern(wsBase, '**/chatSessions/*.jsonl');
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  watcher.onDidCreate(uri => onSessionFileChanged(uri));
  watcher.onDidChange(uri => onSessionFileChanged(uri));

  watchers.push(watcher);
  outputChannel.appendLine(`[capture] Watching ${wsBase}/**/chatSessions/*.jsonl`);

  // Also scan for existing sessions that haven't been captured yet
  scanExistingSessions(wsBase);
}

function onSessionFileChanged(uri: vscode.Uri): void {
  if (paused) return;

  const config = vscode.workspace.getConfiguration('contextforge');
  if (!config.get<boolean>('autoCapture', true)) return;

  const filepath = uri.fsPath;
  const delaySeconds = config.get<number>('captureDelaySeconds', 30);

  // Debounce: reset timer every time the file changes
  const existing = pendingCaptures.get(filepath);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingCaptures.delete(filepath);
    captureSession(filepath);
  }, delaySeconds * 1000);

  pendingCaptures.set(filepath, timer);
}

function captureSession(filepath: string): void {
  try {
    const stat = fs.statSync(filepath);
    const lastMtime = capturedMtimes.get(filepath);
    if (lastMtime && stat.mtimeMs <= lastMtime) {
      return; // No changes since last capture
    }

    const content = fs.readFileSync(filepath, 'utf8');
    const session = parseSessionFile(content);
    if (!session) {
      outputChannel.appendLine(`[capture] Could not parse: ${path.basename(filepath)}`);
      return;
    }

    // Check minimum message count
    const config = vscode.workspace.getConfiguration('contextforge');
    const minMessages = config.get<number>('minMessages', 2);
    if (session.messages.length < minMessages) {
      outputChannel.appendLine(`[capture] Skipping ${session.sessionId}: only ${session.messages.length} messages (min: ${minMessages})`);
      return;
    }

    // Check if already processed — pass message count to allow re-capture when conversation grows
    if (isAlreadyProcessed(session.sessionId, session.messages.length)) {
      capturedMtimes.set(filepath, stat.mtimeMs);
      return;
    }

    // Determine workspace path
    const workspace = getWorkspaceFromSessionPath(filepath);

    writeToInbox({
      sessionId: session.sessionId,
      workspace,
      title: session.title,
      messages: session.messages,
      capturedAt: Date.now(),
    });

    markProcessed(session.sessionId, session.messages.length);
    capturedMtimes.set(filepath, stat.mtimeMs);

    outputChannel.appendLine(
      `[capture] Captured: "${session.title}" (${session.messages.length} messages) → inbox`,
    );
  } catch (err) {
    outputChannel.appendLine(`[capture] Error processing ${filepath}: ${err}`);
  }
}

function getWorkspaceFromSessionPath(sessionFilePath: string): string {
  // Session files are at: workspaceStorage/<hash>/chatSessions/<id>.jsonl
  // Try to find the workspace folder from VS Code's workspace state
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    return workspaceFolders[0].uri.fsPath;
  }
  // Fallback: extract from path
  return path.dirname(path.dirname(sessionFilePath));
}

function scanExistingSessions(wsBase: string): void {
  try {
    const hashes = fs.readdirSync(wsBase);
    for (const hash of hashes) {
      const chatDir = path.join(wsBase, hash, 'chatSessions');
      if (!fs.existsSync(chatDir)) continue;

      const files = fs.readdirSync(chatDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const filepath = path.join(chatDir, file);
        const sessionId = path.basename(file, '.jsonl');
        if (!isAlreadyProcessed(sessionId)) {
          // Capture existing session (with a small delay to not block startup)
          setTimeout(() => captureSession(filepath), 5000);
        }
      }
    }
  } catch {
    // Silently ignore scan errors
  }
}
