import * as vscode from 'vscode';
import { AndroidLogcatViewProvider } from './provider/AndroidLogcatViewProvider';

/**
 * 激活扩展
 * @param context VS Code 扩展上下文
 */
export function activate(context: vscode.ExtensionContext): void {
  const provider = new AndroidLogcatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AndroidLogcatViewProvider.viewId, provider)
  );

  // 注册命令：打开面板
  context.subscriptions.push(
    vscode.commands.registerCommand('cursorAndroidLogcat.start', async () => {
      await vscode.commands.executeCommand('workbench.view.panel');
    })
  );

  // 注册命令：停止日志捕获
  context.subscriptions.push(
    vscode.commands.registerCommand('cursorAndroidLogcat.stop', () => {
      provider.stopProcess();
    })
  );

  // 注册命令：刷新设备列表
  context.subscriptions.push(
    vscode.commands.registerCommand('cursorAndroidLogcat.refreshDevices', async () => {
      await provider.refreshDevices();
    })
  );
}

/**
 * 停用扩展
 */
export function deactivate(): void {
  // 清理资源（如果需要）
}


