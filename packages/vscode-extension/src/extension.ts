import * as vscode from 'vscode';
import * as path from 'path';
import { initCapture, disposeCapture, setPaused, isPaused } from './capture';
import { initStatusBar, updateStatusBar, disposeStatusBar } from './statusBar';
import { registerChatParticipant } from './chatParticipant';
import { getInboxCount } from './inbox';
import { ensureSetup } from './setup';
import { patchNativeModuleResolution } from './vscode/dbProvider';

let outputChannel: vscode.OutputChannel;
let disposeLmToolsFn: (() => Promise<void>) | null = null;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('ContextForge');
  outputChannel.appendLine('ContextForge Capture extension activated');

  // 1. Patch native module resolution BEFORE loading the tools bundle
  patchNativeModuleResolution(context.extensionPath);

  // 2. Register native VS Code LM tools (loaded from separate bundle)
  try {
    const toolsPath = path.join(context.extensionPath, 'dist', 'lmTools.bundle.js');
    const { registerLmTools, disposeLmTools } = require(toolsPath);
    registerLmTools(context);
    disposeLmToolsFn = disposeLmTools;
    outputChannel.appendLine('Native LM tools registered');
  } catch (err) {
    outputChannel.appendLine(`Failed to register native LM tools: ${err}`);
  }

  // Run first-time setup (idempotent — skips if already done)
  ensureSetup(context, outputChannel);

  // Initialize auto-capture watcher
  initCapture(outputChannel);

  // Initialize status bar
  const statusItem = initStatusBar();
  context.subscriptions.push(statusItem);

  // Register chat participant
  registerChatParticipant(context);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('contextforge.captureNow', async () => {
      const pending = getInboxCount();
      vscode.window.showInformationMessage(
        `ContextForge: ${pending} conversations in inbox awaiting MCP processing.`,
      );
    }),

    vscode.commands.registerCommand('contextforge.status', async () => {
      const pending = getInboxCount();
      const autoCapture = vscode.workspace.getConfiguration('contextforge').get('autoCapture', true);
      const items: vscode.QuickPickItem[] = [
        { label: '$(database) Inbox', description: `${pending} conversations pending` },
        { label: '$(eye) Auto-capture', description: autoCapture ? 'Enabled' : 'Disabled' },
        { label: '$(pulse) Capture state', description: isPaused() ? 'Paused' : 'Active' },
      ];
      const selected = await vscode.window.showQuickPick(items, { title: 'ContextForge Status' });
      if (!selected) return;
    }),

    vscode.commands.registerCommand('contextforge.pause', () => {
      setPaused(true);
      updateStatusBar();
      vscode.window.showInformationMessage('ContextForge: Auto-capture paused');
    }),

    vscode.commands.registerCommand('contextforge.resume', () => {
      setPaused(false);
      updateStatusBar();
      vscode.window.showInformationMessage('ContextForge: Auto-capture resumed');
    }),

    vscode.commands.registerCommand('contextforge.setup', async () => {
      await ensureSetup(context, outputChannel);
    }),
  );

  outputChannel.appendLine('All components initialized');
}

export async function deactivate(): Promise<void> {
  if (disposeLmToolsFn) {
    await disposeLmToolsFn();
  }
  disposeCapture();
  disposeStatusBar();
}
