/**
 * Chat participant @memory for manual interaction with the ContextForge knowledge graph.
 *
 * Commands:
 *   @memory save   — capture the current conversation
 *   @memory search <query> — search the knowledge graph
 *   @memory status — show memory status
 *   @memory (plain) — search by default
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { writeToInbox, getInboxCount } from './inbox';
import { ChatMessage } from './sessionParser';

export function registerChatParticipant(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(
    'contextforge.memory',
    chatHandler,
  );

  participant.iconPath = new vscode.ThemeIcon('database');
  context.subscriptions.push(participant);
}

async function chatHandler(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  const command = request.command;

  if (command === 'save') {
    return handleSave(request, context, stream);
  } else if (command === 'search') {
    return handleSearch(request, stream);
  } else if (command === 'status') {
    return handleStatus(stream);
  } else {
    // Default: if text provided, treat as search; otherwise show help
    if (request.prompt.trim()) {
      return handleSearch(request, stream);
    }
    return handleHelp(stream);
  }
}

async function handleSave(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
): Promise<vscode.ChatResult> {
  // Extract conversation history from chat context
  const messages: ChatMessage[] = [];

  for (const turn of chatContext.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push({ role: 'user', content: turn.prompt });
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .filter((part): part is vscode.ChatResponseMarkdownPart => part instanceof vscode.ChatResponseMarkdownPart)
        .map(part => part.value.value)
        .join('\n');
      if (text) {
        messages.push({ role: 'assistant', content: text });
      }
    }
  }

  if (messages.length < 2) {
    stream.markdown('No conversation history to save. Have a conversation first, then use `@memory /save`.');
    return {};
  }

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'unknown';
  const sessionId = `manual-${Date.now()}`;
  const title = request.prompt.trim() || `Manual save from ${path.basename(workspace)}`;

  writeToInbox({
    sessionId,
    workspace,
    title,
    messages,
    capturedAt: Date.now(),
  });

  stream.markdown(
    `Saved **${messages.length} messages** to the knowledge graph inbox.\n\n` +
    `The MCP server will extract entities, relationships, and facts from this conversation ` +
    `on its next read. Title: *"${title}"*`,
  );

  return {};
}

async function handleSearch(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
): Promise<vscode.ChatResult> {
  stream.markdown(
    `To search your knowledge graph, use the **search_memory** MCP tool in your normal chat:\n\n` +
    `> Tell me what you remember about "${request.prompt}"\n\n` +
    `The agent will automatically call \`search_memory\` when you ask about past work. ` +
    `If it doesn't, the contextforge instructions may not be installed — ` +
    `check \`~/Library/Application Support/Code/User/prompts/contextforge.instructions.md\`.`,
  );
  return {};
}

async function handleStatus(
  stream: vscode.ChatResponseStream,
): Promise<vscode.ChatResult> {
  const pending = getInboxCount();

  stream.markdown(
    `## ContextForge Status\n\n` +
    `- **Inbox**: ${pending} conversations pending processing\n` +
    `- **Auto-capture**: ${vscode.workspace.getConfiguration('contextforge').get('autoCapture', true) ? 'enabled' : 'disabled'}\n\n` +
    `For detailed memory stats, ask the agent: *"What's the memory status?"* — ` +
    `it will call the \`memory_status\` MCP tool.`,
  );
  return {};
}

async function handleHelp(
  stream: vscode.ChatResponseStream,
): Promise<vscode.ChatResult> {
  stream.markdown(
    `## ContextForge\n\n` +
    `I help you manage your persistent knowledge graph.\n\n` +
    `**Commands:**\n` +
    `- \`@memory /save\` — Save the current conversation to the knowledge graph\n` +
    `- \`@memory /search <query>\` — Tips for searching past work\n` +
    `- \`@memory /status\` — Show capture status\n\n` +
    `**Auto-capture** is running in the background — completed conversations are ` +
    `automatically saved to the knowledge graph. Use \`@memory /save\` when you want ` +
    `to save immediately without waiting for auto-capture.`,
  );
  return {};
}
