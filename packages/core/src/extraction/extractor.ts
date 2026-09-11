import { ExtractedKnowledge, RawMessage, EntityType, RelationType } from '../models';

/**
 * Default ticket/issue ID patterns. Each regex must have a capture group for the ID.
 * Override via CONTEXTFORGE_TICKET_PATTERNS env var (JSON array of regex strings).
 */
const DEFAULT_TICKET_PATTERNS = [
  /\b([A-Z]{2,10}-\d{1,6})\b/g,            // JIRA-style: PROJ-123, AUTH-4567
  /(?:^|\s)#(\d{2,6})\b/g,                  // GitHub issues: #123
  /(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\s+#(\d{2,6})\b/gi, // fix #123
];

/**
 * Words near a file name that suggest the file was modified (not just referenced).
 */
const MODIFY_SIGNALS = /\b(?:changed?|modified?|updated?|edited?|fix(?:ed)?|refactor(?:ed)?|rewrote|created?|added?|removed?|deleted?|replaced?)\b/i;

/**
 * Rule-based knowledge extractor.
 * Processes raw conversation messages and extracts entities, relations, and facts
 * without requiring any external LLM or model.
 *
 * Extraction strategy:
 * 1. Scan messages for file paths, function names, library names, error patterns, ticket IDs
 * 2. Identify relationships from code context (imports, calls, test files)
 * 3. Extract decisions and key facts from assistant responses
 * 4. Classify files as modified vs referenced based on surrounding language
 * 5. Generate a conversation summary from user/assistant messages
 */
export class Extractor {
  private workspace: string;
  private conversationId: string;
  private ticketPatterns: RegExp[];

  constructor(workspace: string, conversationId: string) {
    this.workspace = workspace;
    this.conversationId = conversationId;
    this.ticketPatterns = this.loadTicketPatterns();
  }

  private loadTicketPatterns(): RegExp[] {
    const envPatterns = process.env.CONTEXTFORGE_TICKET_PATTERNS;
    if (envPatterns) {
      try {
        const patterns = JSON.parse(envPatterns) as string[];
        return patterns.map(p => new RegExp(p, 'gi'));
      } catch {
        // Fall back to defaults if env var is invalid
      }
    }
    return DEFAULT_TICKET_PATTERNS;
  }

  extract(messages: RawMessage[]): ExtractedKnowledge {
    const entities: ExtractedKnowledge['entities'] = [];
    const relations: ExtractedKnowledge['relations'] = [];
    const facts: ExtractedKnowledge['facts'] = [];
    const seenEntities = new Set<string>();
    const entityRoles = new Map<string, 'modified' | 'referenced'>();

    for (const msg of messages) {
      // Extract file references
      for (const file of this.extractFiles(msg.content)) {
        const key = `file:${file}`;
        if (!seenEntities.has(key)) {
          entities.push({
            type: 'file',
            name: file,
            workspace: this.workspace,
            metadata: {},
          });
          seenEntities.add(key);
        }
        // Classify file role based on surrounding context
        const role = this.classifyFileRole(msg.content, file, msg.role);
        if (role === 'modified' || !entityRoles.has(key)) {
          entityRoles.set(key, role);
        }
      }

      // Extract library/package references
      for (const lib of this.extractLibraries(msg.content)) {
        const key = `library:${lib}`;
        if (!seenEntities.has(key)) {
          entities.push({
            type: 'library',
            name: lib,
            workspace: this.workspace,
            metadata: {},
          });
          seenEntities.add(key);
        }
      }

      // Extract function/class names
      for (const fn of this.extractFunctions(msg.content)) {
        const key = `function:${fn}`;
        if (!seenEntities.has(key)) {
          entities.push({
            type: 'function',
            name: fn,
            workspace: this.workspace,
            metadata: {},
          });
          seenEntities.add(key);
        }
      }

      // Extract error patterns
      for (const err of this.extractErrors(msg.content)) {
        const key = `error:${err}`;
        if (!seenEntities.has(key)) {
          entities.push({
            type: 'error',
            name: err,
            workspace: this.workspace,
            metadata: {},
          });
          seenEntities.add(key);
        }
      }

      // Extract ticket/issue IDs
      for (const ticket of this.extractTickets(msg.content)) {
        const key = `ticket:${ticket}`;
        if (!seenEntities.has(key)) {
          entities.push({
            type: 'ticket',
            name: ticket,
            workspace: this.workspace,
            metadata: {},
          });
          seenEntities.add(key);
        }
      }

      // Extract decisions and patterns from assistant AND user messages
      // Users often state decisions: "I'll use X", "let's go with Y"
      if (msg.role === 'assistant' || msg.role === 'user') {
        for (const decision of this.extractDecisions(msg.content)) {
          const key = `decision:${decision.name}`;
          if (!seenEntities.has(key)) {
            entities.push({
              type: 'decision',
              name: decision.name,
              workspace: this.workspace,
              metadata: {},
            });
            seenEntities.add(key);
          }
          facts.push({
            entityId: key,
            key: 'reason',
            value: decision.reason,
            confidence: decision.confidence,
            sourceConversationId: this.conversationId,
          });
        }
      }
    }

    // Build relations from co-occurrence and patterns
    this.buildRelations(entities, messages, relations);

    // Generate conversation summary
    const summary = this.generateSummary(messages, entities);

    return { entities, relations, facts, entityRoles, summary };
  }

  // ─── Private extraction methods ───────────────────────────

  /**
   * Extract ticket/issue IDs using configurable patterns.
   * Default: JIRA (PROJ-123), GitHub (#456), fix/close references.
   */
  private extractTickets(text: string): string[] {
    const tickets: string[] = [];
    for (const pattern of this.ticketPatterns) {
      // Reset lastIndex for global regex reuse
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const ticket = match[1] || match[0];
        if (ticket.length >= 2 && ticket.length <= 20) {
          tickets.push(ticket);
        }
      }
    }
    return [...new Set(tickets)];
  }

  /**
   * Classify whether a file was modified or merely referenced in a message.
   * Looks for action words (changed, updated, fixed, created, etc.) near the filename.
   * Both user and assistant messages with modify signals → 'modified'; otherwise → 'referenced'.
   */
  private classifyFileRole(text: string, fileName: string, role: string): 'modified' | 'referenced' {
    const idx = text.indexOf(fileName);
    if (idx === -1) return 'referenced';

    // Look at a window around the file mention
    const windowStart = Math.max(0, idx - 100);
    const windowEnd = Math.min(text.length, idx + fileName.length + 100);
    const window = text.slice(windowStart, windowEnd);

    if ((role === 'assistant' || role === 'user') && MODIFY_SIGNALS.test(window)) {
      return 'modified';
    }
    return 'referenced';
  }

  /**
   * Generate a short summary of the conversation from messages.
   * Takes the first user message as the topic, and counts what was done.
   */
  private generateSummary(
    messages: RawMessage[],
    entities: ExtractedKnowledge['entities'],
  ): string {
    const userMessages = messages.filter(m => m.role === 'user');
    const topic = userMessages.length > 0
      ? userMessages[0].content.slice(0, 150).replace(/\n/g, ' ').trim()
      : 'No user messages';

    const typeCounts = new Map<string, number>();
    for (const e of entities) {
      typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
    }
    const countParts = Array.from(typeCounts.entries())
      .map(([type, count]) => `${count} ${type}${count > 1 ? 's' : ''}`)
      .join(', ');

    return `${topic}${countParts ? ` | Extracted: ${countParts}` : ''}`;
  }

  private extractFiles(text: string): string[] {
    const files: string[] = [];
    // Match file paths: src/foo/bar.ts, ./component.tsx, etc.
    const fileRegex = /(?:^|\s|['"`(])([a-zA-Z0-9_./-]+\.(?:ts|tsx|js|jsx|py|java|kt|go|rs|rb|css|scss|html|json|yaml|yml|toml|md|sql|sh|bash|zsh|dockerfile|xml|gradle|swift|c|cpp|h|hpp))\b/gi;
    let match: RegExpExecArray | null;
    while ((match = fileRegex.exec(text)) !== null) {
      const file = match[1].replace(/^\.\//, '');
      if (file.length > 2 && file.length < 200 && !file.startsWith('http')) {
        files.push(file);
      }
    }
    return [...new Set(files)];
  }

  private extractLibraries(text: string): string[] {
    const libs: string[] = [];

    // npm/yarn: import ... from 'package' or require('package')
    const importRegex = /(?:from\s+['"]|require\s*\(\s*['"])(@?[a-z0-9][\w./-]*)/gi;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(text)) !== null) {
      const pkg = match[1];
      // Skip relative imports
      if (!pkg.startsWith('.') && !pkg.startsWith('/')) {
        // Take just the package name (not deep paths)
        const name = pkg.startsWith('@')
          ? pkg.split('/').slice(0, 2).join('/')
          : pkg.split('/')[0];
        libs.push(name);
      }
    }

    // pip: import X, from X import Y
    const pyImportRegex = /(?:^|\n)\s*(?:from\s+|import\s+)([a-z_][a-z0-9_]*)/gi;
    while ((match = pyImportRegex.exec(text)) !== null) {
      libs.push(match[1]);
    }

    return [...new Set(libs)];
  }

  private extractFunctions(text: string): string[] {
    const fns: string[] = [];

    // function declarations, arrow functions, method definitions
    const fnRegex = /(?:function\s+|(?:async\s+)?(?:const|let|var)\s+)([a-zA-Z_$][\w$]*)\s*(?:=\s*(?:async\s*)?\(|[\s(])/g;
    let match: RegExpExecArray | null;
    while ((match = fnRegex.exec(text)) !== null) {
      fns.push(match[1]);
    }

    // class declarations
    const classRegex = /class\s+([A-Z][\w]*)/g;
    while ((match = classRegex.exec(text)) !== null) {
      fns.push(match[1]);
    }

    // method definitions
    const methodRegex = /(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*\w+\s*)?{/g;
    while ((match = methodRegex.exec(text)) !== null) {
      const name = match[1];
      if (!['if', 'for', 'while', 'switch', 'catch', 'function'].includes(name)) {
        fns.push(name);
      }
    }

    return [...new Set(fns)];
  }

  private extractErrors(text: string): string[] {
    const errors: string[] = [];

    // Common error patterns
    const errorRegex = /(?:Error|Exception|ENOENT|EACCES|ETIMEDOUT|TypeError|ReferenceError|SyntaxError|Cannot find|Module not found|Failed to|Unable to)[:\s].*?(?:\n|$)/gi;
    let match: RegExpExecArray | null;
    while ((match = errorRegex.exec(text)) !== null) {
      const err = match[0].trim().slice(0, 200); // Cap length
      if (err.length > 10) {
        errors.push(err);
      }
    }

    return [...new Set(errors)];
  }

  private extractDecisions(text: string): Array<{ name: string; reason: string; confidence: number }> {
    const decisions: Array<{ name: string; reason: string; confidence: number }> = [];

    // Patterns that indicate decisions
    const decisionPatterns = [
      // "I'll use X because Y" / "Using X since Y"
      /(?:I'll\s+use|using|chose|choosing|switching\s+to|opting\s+for)\s+(.+?)\s+(?:because|since|as|due\s+to|for)\s+(.+?)(?:\.|$)/gi,
      // "X instead of Y"
      /(?:use|using|chose)\s+(.+?)\s+instead\s+of\s+(.+?)(?:\.|$)/gi,
      // "We should X" pattern
      /(?:we\s+should|you\s+should|let's|I\s+recommend)\s+(.+?)(?:\.|$)/gi,
    ];

    for (const pattern of decisionPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const name = match[1].trim().slice(0, 100);
        const reason = (match[2] || 'stated in conversation').trim().slice(0, 300);
        if (name.length > 3) {
          decisions.push({ name, reason, confidence: 0.7 });
        }
      }
    }

    return decisions;
  }

  private buildRelations(
    entities: ExtractedKnowledge['entities'],
    messages: RawMessage[],
    relations: ExtractedKnowledge['relations'],
  ): void {
    const files = entities.filter(e => e.type === 'file');
    const libs = entities.filter(e => e.type === 'library');
    const functions = entities.filter(e => e.type === 'function');
    const errors = entities.filter(e => e.type === 'error');
    const tickets = entities.filter(e => e.type === 'ticket');

    const fullText = messages.map(m => m.content).join('\n');

    // File → uses → Library (if both mentioned in same conversation)
    for (const file of files) {
      for (const lib of libs) {
        if (this.coOccursInContext(fullText, file.name, lib.name)) {
          relations.push({
            sourceId: `file:${file.name}`,
            targetId: `library:${lib.name}`,
            type: 'uses',
            context: 'co-occurred in conversation',
            conversationId: this.conversationId,
          });
        }
      }
    }

    // Test file → tests → source file
    for (const file of files) {
      if (file.name.includes('.test.') || file.name.includes('.spec.') || file.name.includes('__tests__')) {
        const sourceName = file.name
          .replace('.test.', '.')
          .replace('.spec.', '.')
          .replace('__tests__/', '');
        const source = files.find(f => f.name === sourceName || f.name.endsWith(sourceName));
        if (source) {
          relations.push({
            sourceId: `file:${file.name}`,
            targetId: `file:${source.name}`,
            type: 'tests',
            context: 'test file pattern',
            conversationId: this.conversationId,
          });
        }
      }
    }

    // Error → caused_by → File (if error and file mentioned together)
    for (const error of errors) {
      for (const file of files) {
        if (this.coOccursInContext(fullText, error.name, file.name)) {
          relations.push({
            sourceId: `error:${error.name}`,
            targetId: `file:${file.name}`,
            type: 'caused_by',
            context: 'error associated with file',
            conversationId: this.conversationId,
          });
        }
      }
    }

    // File → contains → Function (if mentioned near each other)
    for (const file of files) {
      for (const fn of functions) {
        if (this.coOccursInContext(fullText, file.name, fn.name)) {
          relations.push({
            sourceId: `file:${file.name}`,
            targetId: `function:${fn.name}`,
            type: 'contains',
            context: 'function mentioned with file',
            conversationId: this.conversationId,
          });
        }
      }
    }

    // Ticket → modifies → File (if ticket and file mentioned in same context)
    for (const ticket of tickets) {
      for (const file of files) {
        if (this.coOccursInContext(fullText, ticket.name, file.name)) {
          relations.push({
            sourceId: `ticket:${ticket.name}`,
            targetId: `file:${file.name}`,
            type: 'modifies',
            context: 'ticket associated with file',
            conversationId: this.conversationId,
          });
        }
      }
    }
  }

  /**
   * Check if two terms appear within ~500 chars of each other,
   * suggesting they're contextually related.
   */
  private coOccursInContext(text: string, termA: string, termB: string, windowSize = 500): boolean {
    const lowerText = text.toLowerCase();
    const a = termA.toLowerCase();
    const b = termB.toLowerCase();

    let pos = 0;
    while ((pos = lowerText.indexOf(a, pos)) !== -1) {
      const windowStart = Math.max(0, pos - windowSize);
      const windowEnd = Math.min(lowerText.length, pos + a.length + windowSize);
      const window = lowerText.slice(windowStart, windowEnd);
      if (window.includes(b)) {
        return true;
      }
      pos += 1;
    }
    return false;
  }
}
