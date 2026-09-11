/**
 * Writes captured conversations to the inbox directory for the MCP server to process.
 *
 * The inbox is at ~/.contextforge/inbox/. Each file is a JSON object with:
 *   { sessionId, workspace, title, messages: [{role, content}], capturedAt }
 *
 * The MCP server picks up these files, extracts knowledge, and deletes them.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ChatMessage } from './sessionParser';

const INBOX_DIR = path.join(os.homedir(), '.contextforge', 'inbox');
const PROCESSED_LOG = path.join(os.homedir(), '.contextforge', 'inbox', '.processed');

// In-memory cache of processed session → timestamp for fast re-capture checks
const processedCache = new Map<string, number>();
let processedCacheLoaded = false;

export interface InboxEntry {
  sessionId: string;
  workspace: string;
  title: string;
  messages: ChatMessage[];
  capturedAt: number;
}

function ensureInboxDir(): void {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
}

/**
 * Normalize a sessionId to a filename-safe token before it is used to build
 * inbox file paths or processed-log keys. Session IDs are GUIDs (or
 * `manual-<timestamp>`), so legitimate values pass through unchanged; this
 * strips path-traversal and log-injection characters from untrusted values
 * that originate in parsed Copilot Chat logs.
 */
function safeSessionId(sessionId: string): string {
  const cleaned = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error(`Invalid sessionId: ${JSON.stringify(sessionId)}`);
  }
  return cleaned;
}

function loadProcessedCache(): void {
  if (processedCacheLoaded) return;
  processedCacheLoaded = true;
  if (!fs.existsSync(PROCESSED_LOG)) return;
  const lines = fs.readFileSync(PROCESSED_LOG, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    // Format: sessionId:timestamp or legacy sessionId-only
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const id = line.slice(0, colonIdx);
      const ts = parseInt(line.slice(colonIdx + 1), 10);
      processedCache.set(id, ts || 0);
    } else {
      processedCache.set(line, 0);
    }
  }
}

export function writeToInbox(entry: InboxEntry): string {
  ensureInboxDir();
  const id = safeSessionId(entry.sessionId);
  const filename = `${id}.json`;
  const filepath = path.join(INBOX_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(entry, null, 2));
  return filepath;
}

/**
 * Check if a session has already been processed.
 * Returns false if the session has newer content (messageCount changed),
 * allowing re-capture of ongoing conversations.
 */
export function isAlreadyProcessed(sessionId: string, currentMessageCount?: number): boolean {
  loadProcessedCache();

  const id = safeSessionId(sessionId);

  // If it's currently in the inbox (pending), skip to avoid duplicates
  const pendingPath = path.join(INBOX_DIR, `${id}.json`);
  if (fs.existsSync(pendingPath)) {
    // But if the pending version has fewer messages than current, overwrite it
    if (currentMessageCount !== undefined) {
      try {
        const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
        if (pending.messages && pending.messages.length < currentMessageCount) {
          return false; // Allow re-capture with more messages
        }
      } catch { /* treat as processed */ }
    }
    return true;
  }

  // Check the processed log — allow re-capture if message count grew
  if (processedCache.has(id)) {
    const lastCount = processedCache.get(id)!;
    if (currentMessageCount !== undefined && currentMessageCount > lastCount) {
      return false; // New messages since last capture
    }
    return true;
  }

  return false;
}

export function markProcessed(sessionId: string, messageCount: number): void {
  ensureInboxDir();
  const id = safeSessionId(sessionId);
  processedCache.set(id, messageCount);
  fs.appendFileSync(PROCESSED_LOG, `${id}:${messageCount}\n`);
}

export function getInboxCount(): number {
  ensureInboxDir();
  return fs.readdirSync(INBOX_DIR).filter(f => f.endsWith('.json')).length;
}
