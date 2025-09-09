import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

type DeviceInfo = { serial: string; model?: string };

class AndroidLogcatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'android-logcat-view';
  private static readonly LAST_KEY = 'lastConfig.v1';

  private view?: vscode.WebviewView;
  private currentProc: ChildProcessWithoutNullStreams | null = null;
  private isRunning = false;
  private bufferedWhileHidden = "";
  private isRefreshingDevices = false;
  private isPaused = false;
  private pausedBuffer = "";
  private hasAutoStarted = false;
  private requestedPaused = false;
  private output: vscode.OutputChannel;
  private debugEnabled: boolean;
  private pendingAppend: string = "";
  private appendFlushTimer: NodeJS.Timeout | null = null;
  private readonly APPEND_FLUSH_INTERVAL_MS = 33; // ~30fps 的刷新节奏
  private readonly APPEND_SIZE_THRESHOLD = 64 * 1024; // 达到阈值立即冲刷，减少内存占用

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('Android Logcat (Cursor)');
    this.debugEnabled = !!vscode.workspace.getConfiguration('cursorAndroidLogcat').get('debug');
  }

  private debugLog(...parts: any[]) {
    if (!this.debugEnabled) return;
    try {
      const text = parts.map((p) => {
        if (typeof p === 'string') return p;
        try { return JSON.stringify(p); } catch { return String(p); }
      }).join(' ');
      this.output.appendLine(`[debug] ${text}`);
    } catch {
      // ignore logging errors
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    this.debugLog('resolveWebviewView');
    // 保持 Webview 在隐藏时不被销毁，切换 Tab 后无需重新加载
    webviewView.webview.options = { enableScripts: true, retainContextWhenHidden: true } as any;
    webviewView.webview.html = this.getHtml();

    // 监听配置变化，动态更新调试开关
    const cfgDisp = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cursorAndroidLogcat.debug')) {
        this.debugEnabled = !!vscode.workspace.getConfiguration('cursorAndroidLogcat').get('debug');
        this.debugLog('config changed: debug =', this.debugEnabled);
        this.post({ type: 'debug', enabled: this.debugEnabled });
      }
    });
    this.context.subscriptions.push(cfgDisp);

    // 切换 Tab 或面板时：仅在恢复可见时一次性冲刷隐藏期间积累的日志，避免逐条回放造成的可见延迟
    webviewView.onDidChangeVisibility(async () => {
      this.debugLog('onDidChangeVisibility', { visible: webviewView.visible, hiddenBuffered: this.bufferedWhileHidden.length });
      if (webviewView.visible) {
        if (this.bufferedWhileHidden.length > 0) {
          this.post({ type: 'append', text: this.bufferedWhileHidden });
          this.bufferedWhileHidden = "";
        }
        // 设备列表刷新：放在微任务后异步执行，不阻塞 UI 首帧
        queueMicrotask(() => this.refreshDevicesAsync());
        // 通知前端已重新可见，便于拉取历史
        this.post({ type: 'visible' });
      } else {
        // 切换为不可见：将尚未发送的聚合数据并入隐藏缓冲，取消定时器
        if (this.pendingAppend.length > 0) {
          this.bufferedWhileHidden += this.pendingAppend;
          this.pendingAppend = "";
        }
        this.cancelAppendFlushTimer();
      }
    });

    webviewView.onDidDispose(() => {
      this.debugLog('onDidDispose');
      this.stopProcess();
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type && msg.type !== 'append') this.debugLog('onDidReceiveMessage', msg.type);
      switch (msg.type) {
        case 'ready': {
          this.post({ type: 'debug', enabled: this.debugEnabled });
          this.refreshDevicesAsync();
          this.postLastConfigToWebview();
          this.autoStartIfPossible();
          break;
        }
        case 'requestHistory': {
          const serial = String(msg.serial || '').trim();
          if (!serial) {
            this.post({ type: 'status', text: '请先选择设备' });
            break;
          }
          this.post({ type: 'status', text: '正在加载历史日志...' });
          this.dumpHistory(serial, 10000)
            .then((text) => {
              this.post({ type: 'historyDump', text });
              this.post({ type: 'status', text: '历史日志已加载' });
            })
            .catch(() => {
              this.post({ type: 'status', text: '加载历史日志失败' });
            });
          break;
        }
        case 'clear': {
          // 清空后端缓冲，不终止进程
          this.bufferedWhileHidden = "";
          this.pausedBuffer = "";
          this.post({ type: 'status', text: '已清空（仅UI与缓冲）' });
          this.debugLog('cleared buffers');
          break;
        }
        case 'refreshDevices': {
          this.debugLog('refreshDevices');
          this.refreshDevicesAsync();
          break;
        }
        case 'start': {
          // 恢复：若未运行则启动，若处于暂停则恢复输出
          if (!this.isRunning) {
            if (!msg.serial) {
              this.post({ type: 'status', text: '请先选择设备' });
              return;
            }
            this.debugLog('startProcess by user', { serial: msg.serial, pkg: msg.pkg, tag: msg.tag, level: msg.level, buffer: msg.buffer, save: !!msg.save });
            this.startProcess({
              serial: msg.serial,
              pkg: msg.pkg || '',
              tag: msg.tag || '*',
              level: msg.level || 'D',
              buffer: msg.buffer || 'main',
              save: !!msg.save,
            });
            this.setLastConfig({
              serial: msg.serial,
              pkg: msg.pkg || '',
              tag: msg.tag || '*',
              level: msg.level || 'D',
              buffer: msg.buffer || 'main',
              save: !!msg.save,
            });
            // 恢复语义：用户点击恢复，应清除“期望暂停”标记
            this.requestedPaused = false;
          } else if (this.isPaused) {
            // 恢复：冲刷暂停期间缓存
            if (this.pausedBuffer.length > 0) {
              this.post({ type: 'append', text: this.pausedBuffer });
              this.pausedBuffer = '';
            }
            this.isPaused = false;
            this.requestedPaused = false;
            this.post({ type: 'status', text: '已恢复' });
            this.debugLog('resumed');
          } else {
            this.post({ type: 'status', text: '已在运行中' });
          }
          break;
        }
        case 'stop': // 兼容旧消息名
        case 'pause': {
          // 暂停：不终止进程，只停止向 UI 追加并缓存
          this.requestedPaused = true;
          if (this.isRunning && !this.isPaused) {
            this.isPaused = true;
            this.post({ type: 'status', text: '已暂停' });
            this.debugLog('paused');
          } else if (!this.isRunning) {
            this.post({ type: 'status', text: '未在运行（已记录暂停指令，启动后生效）' });
          }
          break;
        }
      }
    });
  }

  private refreshDevicesAsync() {
    if (this.isRefreshingDevices) return;
    this.isRefreshingDevices = true;
    this.debugLog('listDevices:start');
    this.listDevices()
      .then((devices) => {
        const last = this.getLastConfig();
        this.post({ type: 'devices', devices, defaultSerial: last?.serial ?? '' });
        this.debugLog('listDevices:found', devices?.length ?? 0);
      })
      .finally(() => {
        this.isRefreshingDevices = false;
        this.debugLog('listDevices:done');
      });
  }

  private getLastConfig(): { serial: string; pkg: string; tag: string; level: string; buffer: string; save: boolean } | null {
    const raw = this.context.globalState.get<any>(AndroidLogcatViewProvider.LAST_KEY);
    if (!raw) return null;
    const { serial = '', pkg = '', tag = '*', level = 'D', buffer = 'main', save = false } = raw as any;
    return { serial, pkg, tag, level, buffer, save };
  }

  private setLastConfig(cfg: { serial: string; pkg: string; tag: string; level: string; buffer: string; save: boolean }) {
    void this.context.globalState.update(AndroidLogcatViewProvider.LAST_KEY, cfg);
  }

  private postLastConfigToWebview() {
    const last = this.getLastConfig();
    if (last) {
      this.post({ type: 'config', config: last });
      this.debugLog('post config', last);
    }
  }

  private async autoStartIfPossible() {
    if (this.hasAutoStarted || this.isRunning) return;
    this.debugLog('autoStartIfPossible:checking');
    const devices = await this.listDevices();
    if (!devices || devices.length === 0) {
      this.post({ type: 'status', text: '未检测到设备，自动启动跳过' });
      this.debugLog('autoStartIfPossible:no devices');
      return;
    }
    const last = this.getLastConfig();
    let targetSerial = last?.serial;
    if (!targetSerial || !devices.find(d => d.serial === targetSerial)) {
      targetSerial = devices[0].serial;
    }
    const startCfg = {
      serial: targetSerial,
      pkg: last?.pkg ?? '',
      tag: last?.tag ?? '*',
      level: last?.level ?? 'D',
      buffer: last?.buffer ?? 'main',
      save: last?.save ?? false,
    };
    this.debugLog('autoStartIfPossible:start', startCfg);
    this.startProcess(startCfg);
    this.setLastConfig(startCfg);
    this.hasAutoStarted = true;
  }

  private post(message: any) {
    if (this.debugEnabled && message && message.type && message.type !== 'append') {
      this.debugLog('post -> webview', message.type);
    }
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
    this.debugLog('spawn', { scriptPath, args });
    // 如果在启动前用户已请求暂停，则立即进入暂停模式，开始缓冲但不输出
    if (this.requestedPaused) {
      this.isPaused = true;
      this.post({ type: 'status', text: '按用户指令：启动后立即暂停' });
      this.debugLog('requestedPaused honored at start');
    }

    proc.stdout.on('data', (buf) => {
      const chunk = buf.toString();
      if (this.isPaused) {
        this.pausedBuffer += chunk;
      } else if (this.view?.visible) {
        this.queueAppend(chunk);
      } else {
        this.bufferedWhileHidden += chunk;
      }
    });
    proc.stderr.on('data', (buf) => {
      const chunk = buf.toString();
      if (this.isPaused) {
        this.pausedBuffer += chunk;
      } else if (this.view?.visible) {
        this.queueAppend(chunk);
      } else {
        this.bufferedWhileHidden += chunk;
      }
    });
    proc.on('close', (code, signal) => {
      this.post({ type: 'status', text: `已退出 (code=${code}, signal=${signal ?? ''})` });
      this.debugLog('process closed', { code, signal });
      this.isRunning = false;
      this.currentProc = null;
      this.bufferedWhileHidden = "";
      this.isPaused = false;
      this.pausedBuffer = '';
    });
    proc.on('error', (err) => {
      this.post({ type: 'status', text: `进程错误: ${String(err)}` });
      this.debugLog('process error', String(err));
    });
  }

  private queueAppend(text: string) {
    this.pendingAppend += text;
    if (this.pendingAppend.length >= this.APPEND_SIZE_THRESHOLD) {
      this.flushAppendNow();
      return;
    }
    if (!this.appendFlushTimer) {
      this.appendFlushTimer = setTimeout(() => this.flushAppendNow(), this.APPEND_FLUSH_INTERVAL_MS);
    }
  }

  private flushAppendNow() {
    if (!this.pendingAppend) {
      this.cancelAppendFlushTimer();
      return;
    }
    // 仅在可见时发送；若不可见，合并到隐藏缓冲
    if (this.view?.visible) {
      this.post({ type: 'append', text: this.pendingAppend });
    } else {
      this.bufferedWhileHidden += this.pendingAppend;
    }
    this.pendingAppend = "";
    this.cancelAppendFlushTimer();
  }

  private cancelAppendFlushTimer() {
    if (this.appendFlushTimer) {
      clearTimeout(this.appendFlushTimer);
      this.appendFlushTimer = null;
    }
  }

  private async dumpHistory(serial: string, maxLines: number = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['-s', serial, 'logcat', '-d', '-b', 'all', '-v', 'time', '-t', String(maxLines)];
      this.debugLog('dumpHistory adb', args.join(' '));
      const proc = spawn('adb', args);
      const chunks: Buffer[] = [];
      proc.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
      proc.stderr.on('data', (d) => chunks.push(Buffer.from(d)));
      proc.on('close', () => {
        try {
          resolve(Buffer.concat(chunks).toString());
        } catch {
          reject(new Error('concat failed'));
        }
      });
      proc.on('error', () => reject(new Error('spawn failed')));
    });
  }

  private stopProcess() {
    this.debugLog('stopProcess');
    if (this.currentProc) {
      try {
        this.currentProc.kill('SIGINT');
      } catch {
        // ignore
      }
    }
    this.currentProc = null;
    this.isRunning = false;
    this.isPaused = false;
    this.pausedBuffer = '';
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
      .replace('/*INJECT_STYLE*/', css)
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


