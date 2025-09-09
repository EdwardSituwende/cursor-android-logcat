import * as vscode from 'vscode';
import { AndroidLogcatViewProvider } from './provider/AndroidLogcatViewProvider';

export function activate(context: vscode.ExtensionContext) {
  const provider = new AndroidLogcatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AndroidLogcatViewProvider.viewId, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorAndroidLogcat.start', () => {
      vscode.commands.executeCommand('workbench.view.panel');
    }),
    vscode.commands.registerCommand('cursorAndroidLogcat.stop', () => {
      (provider as any)['stopProcess']?.();
    }),
    vscode.commands.registerCommand('cursorAndroidLogcat.refreshDevices', async () => {
      (provider as any)['post']?.({ type: 'status', text: '刷新设备...' });
      const devices = await (provider as any)['listDevices']?.();
      (provider as any)['post']?.({ type: 'devices', devices });
    })
  );
}

export function deactivate() {}


