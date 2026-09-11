/**
 * Parses VS Code Copilot Chat session JSONL files into conversation messages.
 *
 * Session files are append-only event logs with three event kinds:
 *   kind 0: initial session state
 *   kind 1: update at path (k=path, v=value)
 *   kind 2: push to array at path (k=path, v=element)
 *
 * Requests are added via kind:2 events with k=["requests"].
 * Response parts are added via kind:2 events with k=["requests", N, "response"].
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ParsedSession {
  sessionId: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  lastUpdatedAt: number;
}

interface SessionEvent {
  kind: number;
  k?: (string | number)[];
  v: unknown;
}

interface SessionRequest {
  requestId?: string;
  timestamp?: number;
  message?: { text: string; parts?: unknown[] };
  response?: Record<string, ResponsePart>;
}

interface ResponsePart {
  kind?: string;
  value?: string;
}

export function parseSessionFile(content: string): ParsedSession | null {
  const lines = content.split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  let sessionId = '';
  let title = '';
  let createdAt = 0;
  let lastUpdatedAt = 0;

  // Track requests by index
  const requests: SessionRequest[] = [];

  for (const line of lines) {
    let event: SessionEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.kind === 0) {
      // Initial session state
      const v = event.v as Record<string, unknown>;
      sessionId = (v.sessionId as string) || '';
      title = (v.customTitle as string) || '';
      createdAt = (v.creationDate as number) || 0;
      lastUpdatedAt = createdAt;

      // May already have requests in the initial state
      if (Array.isArray(v.requests)) {
        for (const req of v.requests) {
          requests.push(req as SessionRequest);
        }
      }
    } else if (event.kind === 1 && event.k) {
      // Update at path
      if (event.k.length === 1 && event.k[0] === 'customTitle') {
        title = event.v as string;
      }
      // Update response parts or other nested properties
      if (event.k[0] === 'requests' && typeof event.k[1] === 'number') {
        const reqIdx = event.k[1] as number;
        if (!requests[reqIdx]) requests[reqIdx] = {};

        if (event.k.length === 3) {
          // e.g. ["requests", 0, "result"]
          (requests[reqIdx] as Record<string, unknown>)[event.k[2] as string] = event.v;
        }
      }
      lastUpdatedAt = Date.now();
    } else if (event.kind === 2 && event.k) {
      // Push to array
      const kStr = JSON.stringify(event.k);

      if (kStr === '["requests"]') {
        // New request added
        const v = event.v as Record<string, unknown>;
        const req = (v[0] || v) as SessionRequest;
        requests.push(req);
        lastUpdatedAt = req.timestamp || Date.now();
      } else if (event.k[0] === 'requests' && typeof event.k[1] === 'number' && event.k[2] === 'response') {
        // Response part added to existing request
        const reqIdx = event.k[1] as number;
        if (!requests[reqIdx]) requests[reqIdx] = {};
        if (!requests[reqIdx].response) requests[reqIdx].response = {};

        const v = event.v as Record<string, unknown>;
        const parts = Object.values(v) as ResponsePart[];
        const existingKeys = Object.keys(requests[reqIdx].response!);
        let nextIdx = existingKeys.length;
        for (const part of parts) {
          requests[reqIdx].response![String(nextIdx)] = part;
          nextIdx++;
        }
        lastUpdatedAt = Date.now();
      }
    }
  }

  if (!sessionId || requests.length === 0) return null;

  // Extract messages from requests
  const messages: ChatMessage[] = [];

  for (const req of requests) {
    if (!req) continue;

    // User message
    if (req.message?.text) {
      messages.push({ role: 'user', content: req.message.text });
    }

    // Assistant response — find the main text part (not thinking, not mcpServersStarting)
    if (req.response) {
      const parts = Object.values(req.response) as ResponsePart[];
      const textParts: string[] = [];

      for (const part of parts) {
        // Main response text has kind === undefined or kind === 'markdownContent'
        if (part && part.value && (part.kind === undefined || part.kind === 'markdownContent')) {
          textParts.push(part.value);
        }
      }

      if (textParts.length > 0) {
        // Use the last (most complete) text part
        messages.push({ role: 'assistant', content: textParts[textParts.length - 1] });
      }
    }
  }

  // Derive title from conversation content when no explicit title exists
  if (!title) {
    title = deriveTitleFromMessages(messages);
  }

  return {
    sessionId,
    title,
    messages,
    createdAt,
    lastUpdatedAt,
  };
}

/**
 * Derives a meaningful title from conversation messages.
 * Priority:
 *   1. First user message (cleaned up, truncated)
 *   2. First assistant response summary (if user message is too short/generic)
 */
function deriveTitleFromMessages(messages: ChatMessage[]): string {
  const firstUser = messages.find(m => m.role === 'user');
  if (firstUser) {
    // Clean up: strip markdown, code blocks, excessive whitespace
    let text = firstUser.content
      .replace(/```[\s\S]*?```/g, '')    // remove code blocks
      .replace(/`[^`]+`/g, '')            // remove inline code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // markdown links → text
      .replace(/[#*_~>]/g, '')            // strip markdown formatting
      .replace(/\s+/g, ' ')              // collapse whitespace
      .trim();

    if (text.length > 10) {
      // Truncate at sentence boundary if possible, else hard truncate
      if (text.length > 100) {
        const sentenceEnd = text.indexOf('. ', 30);
        if (sentenceEnd > 0 && sentenceEnd < 100) {
          text = text.slice(0, sentenceEnd + 1);
        } else {
          text = text.slice(0, 100).replace(/\s+\S*$/, '') + '…';
        }
      }
      return text;
    }
  }

  // If user message was too short, try first assistant message
  const firstAssistant = messages.find(m => m.role === 'assistant');
  if (firstAssistant) {
    let text = firstAssistant.content
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, '')
      .replace(/[#*_~>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length > 100) {
      const sentenceEnd = text.indexOf('. ', 20);
      if (sentenceEnd > 0 && sentenceEnd < 100) {
        text = text.slice(0, sentenceEnd + 1);
      } else {
        text = text.slice(0, 100).replace(/\s+\S*$/, '') + '…';
      }
    }
    if (text.length > 10) return text;
  }

  return `Session ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
}
