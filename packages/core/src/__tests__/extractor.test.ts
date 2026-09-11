import { Extractor } from '../extraction/extractor';
import { RawMessage } from '../models';

describe('Extractor', () => {
  const workspace = '/test/project';
  const conversationId = 'test-conv-1';

  function makeMessages(contents: Array<{ role: RawMessage['role']; content: string }>): RawMessage[] {
    return contents.map((c, i) => ({
      id: `msg-${i}`,
      conversationId,
      role: c.role,
      content: c.content,
      timestamp: Date.now(),
    }));
  }

  it('extracts file references', () => {
    const extractor = new Extractor(workspace, conversationId);
    const messages = makeMessages([
      { role: 'user', content: 'Fix the bug in src/auth/login.ts' },
      { role: 'assistant', content: 'I updated src/auth/login.ts and also modified middleware.ts' },
    ]);

    const result = extractor.extract(messages);
    const fileNames = result.entities.filter(e => e.type === 'file').map(e => e.name);

    expect(fileNames).toContain('src/auth/login.ts');
    expect(fileNames).toContain('middleware.ts');
  });

  it('extracts library references from imports', () => {
    const extractor = new Extractor(workspace, conversationId);
    const messages = makeMessages([
      {
        role: 'assistant',
        content: `import express from 'express';\nimport { useState } from 'react';`,
      },
    ]);

    const result = extractor.extract(messages);
    const libNames = result.entities.filter(e => e.type === 'library').map(e => e.name);

    expect(libNames).toContain('express');
    expect(libNames).toContain('react');
  });

  it('extracts error patterns', () => {
    const extractor = new Extractor(workspace, conversationId);
    const messages = makeMessages([
      {
        role: 'assistant',
        content: 'TypeError: Cannot read property "id" of undefined',
      },
    ]);

    const result = extractor.extract(messages);
    const errors = result.entities.filter(e => e.type === 'error');

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].name).toContain('TypeError');
  });

  it('builds test file relations', () => {
    const extractor = new Extractor(workspace, conversationId);
    const messages = makeMessages([
      { role: 'user', content: 'Add tests for auth.ts in auth.test.ts' },
    ]);

    const result = extractor.extract(messages);
    const testRels = result.relations.filter(r => r.type === 'tests');

    expect(testRels.length).toBeGreaterThan(0);
  });

  it('extracts decisions from assistant messages', () => {
    const extractor = new Extractor(workspace, conversationId);
    const messages = makeMessages([
      {
        role: 'assistant',
        content: "I'll use JWT tokens because session-based auth doesn't scale well for microservices.",
      },
    ]);

    const result = extractor.extract(messages);
    const decisions = result.entities.filter(e => e.type === 'decision');

    expect(decisions.length).toBeGreaterThan(0);
    expect(result.facts.length).toBeGreaterThan(0);
  });

  it('deduplicates entities', () => {
    const extractor = new Extractor(workspace, conversationId);
    const messages = makeMessages([
      { role: 'user', content: 'Look at auth.ts' },
      { role: 'assistant', content: 'I see auth.ts has an issue' },
      { role: 'user', content: 'Fix auth.ts' },
    ]);

    const result = extractor.extract(messages);
    const authFiles = result.entities.filter(e => e.name === 'auth.ts');

    expect(authFiles.length).toBe(1);
  });

  it('extracts function definitions', () => {
    const extractor = new Extractor(workspace, conversationId);
    const messages = makeMessages([
      {
        role: 'assistant',
        content: 'function handleLogin(user: string) {\n  return authenticate(user);\n}',
      },
    ]);

    const result = extractor.extract(messages);
    const functions = result.entities.filter(e => e.type === 'function');

    expect(functions.map(f => f.name)).toContain('handleLogin');
  });

  it('extracts JIRA-style ticket IDs', () => {
    const extractor = new Extractor(workspace, conversationId);
    const messages = makeMessages([
      { role: 'user', content: 'Working on AUTH-123 and PROJ-4567' },
      { role: 'assistant', content: 'I see the issue in AUTH-123 relates to the login flow' },
    ]);

    const result = extractor.extract(messages);
    const tickets = result.entities.filter(e => e.type === 'ticket').map(e => e.name);

    expect(tickets).toContain('AUTH-123');
    expect(tickets).toContain('PROJ-4567');
  });

  it('extracts GitHub issue references', () => {
    const extractor = new Extractor(workspace, conversationId);
    const messages = makeMessages([
      { role: 'user', content: 'This fixes #456 and is related to #789' },
    ]);

    const result = extractor.extract(messages);
    const tickets = result.entities.filter(e => e.type === 'ticket').map(e => e.name);

    expect(tickets).toContain('456');
  });

  it('builds ticket-to-file relations', () => {
    const extractor = new Extractor(workspace, conversationId);
    const messages = makeMessages([
      { role: 'user', content: 'Fix AUTH-100 in src/auth/login.ts' },
    ]);

    const result = extractor.extract(messages);
    const ticketRels = result.relations.filter(r => r.type === 'modifies');

    expect(ticketRels.length).toBeGreaterThan(0);
    expect(ticketRels[0].sourceId).toContain('AUTH-100');
  });

  it('classifies files as modified when action words are present', () => {
    const extractor = new Extractor(workspace, conversationId);
    const messages = makeMessages([
      { role: 'assistant', content: 'I updated src/auth/login.ts to fix the issue' },
      { role: 'user', content: 'Also check src/utils/helpers.ts' },
    ]);

    const result = extractor.extract(messages);

    expect(result.entityRoles.get('file:src/auth/login.ts')).toBe('modified');
    expect(result.entityRoles.get('file:src/utils/helpers.ts')).toBe('referenced');
  });

  it('generates a conversation summary', () => {
    const extractor = new Extractor(workspace, conversationId);
    const messages = makeMessages([
      { role: 'user', content: 'Fix the authentication bug in login.ts' },
      { role: 'assistant', content: 'I updated src/auth/login.ts to fix the JWT token issue' },
    ]);

    const result = extractor.extract(messages);

    expect(result.summary).toBeDefined();
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.summary).toContain('Fix the authentication bug');
  });

  it('uses configurable ticket patterns from env var', () => {
    const original = process.env.CONTEXTFORGE_TICKET_PATTERNS;
    process.env.CONTEXTFORGE_TICKET_PATTERNS = JSON.stringify(['\\b(CUSTOM-\\d+)\\b']);

    try {
      const extractor = new Extractor(workspace, conversationId);
      const messages = makeMessages([
        { role: 'user', content: 'Working on CUSTOM-42 and AUTH-999' },
      ]);

      const result = extractor.extract(messages);
      const tickets = result.entities.filter(e => e.type === 'ticket').map(e => e.name);

      expect(tickets).toContain('CUSTOM-42');
      // AUTH-999 should NOT match since we overrode patterns
      expect(tickets).not.toContain('AUTH-999');
    } finally {
      if (original !== undefined) {
        process.env.CONTEXTFORGE_TICKET_PATTERNS = original;
      } else {
        delete process.env.CONTEXTFORGE_TICKET_PATTERNS;
      }
    }
  });
});
