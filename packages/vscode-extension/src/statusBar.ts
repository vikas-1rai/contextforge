/**
 * Status bar item showing ContextForge state.
 * Shows: memory icon + entity count (or "paused" if capture is paused).
 */

import * as vscode from 'vscode';
import { getInboxCount } from './inbox';
import { isPaused } from './capture';

let statusBarItem: vscode.StatusBarItem;
let refreshInterval: NodeJS.Timeout;

export function initStatusBar(): vscode.StatusBarItem {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBarItem.command = 'contextforge.status';
  statusBarItem.tooltip = 'ContextForge — click for status';
  updateStatusBar();

  // Refresh every 30 seconds
  refreshInterval = setInterval(updateStatusBar, 30000);

  statusBarItem.show();
  return statusBarItem;
}

export function updateStatusBar(): void {
  if (!statusBarItem) return;

  if (isPaused()) {
    statusBarItem.text = '$(database) Memory: paused';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    return;
  }

  const pending = getInboxCount();
  if (pending > 0) {
    statusBarItem.text = `$(database) Memory: ${pending} pending`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = '$(database) Memory: active';
    statusBarItem.backgroundColor = undefined;
  }
}

export function disposeStatusBar(): void {
  if (refreshInterval) clearInterval(refreshInterval);
  if (statusBarItem) statusBarItem.dispose();
}
