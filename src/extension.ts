import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

type DeviceInfo = { serial: string; model?: string };

class AndroidLogcatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'android-logcat-view';

  private view?: vscode.WebviewView;
  private currentProc: ChildProcessWithoutNullStreams | null = null;
  private isRunning = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();

    // 切换 Tab 或面板时，视图重新可见则刷新设备列表
    webviewView.onDidChangeVisibility(async () => {
      if (webviewView.visible) {
        const devices = await this.listDevices();
        this.post({ type: 'devices', devices });
      }
    });

    webviewView.onDidDispose(() => {
      this.stopProcess();
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready': {
          const devices = await this.listDevices();
          this.post({ type: 'devices', devices });
          break;
        }
        case 'refreshDevices': {
          const devices = await this.listDevices();
          this.post({ type: 'devices', devices });
          break;
        }
        case 'start': {
          if (this.isRunning) {
            this.post({ type: 'status', text: '已在运行中' });
            return;
          }
          if (!msg.serial) {
            this.post({ type: 'status', text: '请先选择设备' });
            return;
          }
          this.startProcess({
            serial: msg.serial,
            pkg: msg.pkg || '',
            tag: msg.tag || '*',
            level: msg.level || 'D',
            buffer: msg.buffer || 'main',
            save: !!msg.save,
          });
          break;
        }
        case 'stop': {
          this.stopProcess();
          break;
        }
      }
    });
  }

  private post(message: any) {
    this.view?.webview.postMessage(message);
  }

  private getScriptPath(): string {
    const cfg = vscode.workspace.getConfiguration('cursorAndroidLogcat');
    const configured = cfg.get<string>('scriptPath');
    if (configured && configured.trim()) return configured;
    // 默认指向扩展内置脚本
    return path.join(this.context.extensionUri.fsPath, 'scripts', 'logcat_android', 'cli_logcat.sh');
  }

  private startProcess(opts: { serial: string; pkg: string; tag: string; level: string; buffer: string; save?: boolean }) {
    const scriptPath = this.getScriptPath();
    const args: string[] = [];
    if (opts.serial) {
      args.push('-s', opts.serial);
    }
    if (opts.pkg) {
      args.push('-p', opts.pkg);
    }
    if (opts.tag && opts.tag.trim() !== '') {
      args.push('-t', opts.tag.trim());
    }
    if (opts.level) {
      args.push('-l', opts.level);
    }
    if (opts.buffer) {
      args.push('-b', opts.buffer);
    }
    args.push('--no-color');
    if (opts.save) {
      args.push('-f');
    }

    const cwdDir = this.context.extensionUri.fsPath; // 将工作目录固定到扩展目录，确保可写
    const proc = spawn(scriptPath, args, {
      env: { ...process.env, DISABLE_SCRIPT: '1' },
      cwd: cwdDir,
    });
    this.currentProc = proc;
    this.isRunning = true;
    this.post({ type: 'status', text: `启动: ${scriptPath} ${args.join(' ')}` });

    proc.stdout.on('data', (buf) => {
      this.post({ type: 'append', text: buf.toString() });
    });
    proc.stderr.on('data', (buf) => {
      this.post({ type: 'append', text: buf.toString() });
    });
    proc.on('close', (code, signal) => {
      this.post({ type: 'status', text: `已退出 (code=${code}, signal=${signal ?? ''})` });
      this.isRunning = false;
      this.currentProc = null;
    });
    proc.on('error', (err) => {
      this.post({ type: 'status', text: `进程错误: ${String(err)}` });
    });
  }

  private stopProcess() {
    if (this.currentProc) {
      try {
        this.currentProc.kill('SIGINT');
      } catch {
        // ignore
      }
    }
    this.currentProc = null;
    this.isRunning = false;
    this.post({ type: 'status', text: '已停止' });
  }

  private async listDevices(): Promise<DeviceInfo[]> {
    return new Promise((resolve) => {
      const proc = spawn('adb', ['devices', '-l']);
      const chunks: Buffer[] = [];
      proc.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
      proc.stderr.on('data', (d) => chunks.push(Buffer.from(d)));
      proc.on('close', () => {
        const out = Buffer.concat(chunks).toString();
        const lines = out.split(/\r?\n/).slice(1); // skip header
        const devices: DeviceInfo[] = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2 && parts[1] === 'device') {
            const serial = parts[0];
            let model: string | undefined;
            const m = line.match(/model:(\S+)/);
            if (m) model = m[1];
            devices.push({ serial, model });
          }
        }
        resolve(devices);
      });
      proc.on('error', () => resolve([]));
    });
  }

  private getHtml(): string {
    const nonce = Math.random().toString(36).slice(2);
    const csp = `default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const base = this.context.extensionUri.fsPath;
    const htmlPath = path.join(base, 'media', 'view.html');
    const cssPath = path.join(base, 'media', 'view.css');
    const jsPath = path.join(base, 'media', 'view.js');
    const htmlTmpl = fs.readFileSync(htmlPath, 'utf8');
    const css = fs.readFileSync(cssPath, 'utf8');
    const js = fs.readFileSync(jsPath, 'utf8');
    return htmlTmpl
      .replace(/\{\{CSP\}\}/g, csp)
      .replace(/\{\{NONCE\}\}/g, nonce)
      .replace(/\{\{STYLE\}\}/g, css)
      .replace(/\{\{SCRIPT\}\}/g, js);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new AndroidLogcatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AndroidLogcatViewProvider.viewId, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorAndroidLogcat.start', () => {
      // 通过 Webview 触发，或后续扩展为快速启动
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


