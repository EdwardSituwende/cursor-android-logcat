import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractFileName } from '../utils/path';
import { loadWebviewHtml } from '../utils/html';
import { dumpHistory as adbDumpHistory, listDevices as adbListDevices, DeviceInfo, waitForDevice as adbWaitForDevice } from '../utils/adb';
import { ProcessManager } from '../core/processManager';
import { DeviceService } from '../services/DeviceService';
import { StreamService } from '../services/StreamService';
import { ImportService } from '../services/ImportService';
import { PidMapService } from '../services/PidMapService';
import { getLastConfig, setLastConfig, LastConfig } from '../state/configStore';
import { IncomingWebviewMessage } from '../types/messages';
import { getResolvedAdbPath } from '../utils/adb';

export class AndroidLogcatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'android-logcat-view';
  private static readonly LAST_KEY = 'lastConfig.v1';

  private view?: vscode.WebviewView;
  private isRefreshingDevices = false;
  private hasAutoStarted = false;
  private output: vscode.OutputChannel;
  private debugEnabled: boolean;
  private proc: ProcessManager;
  private deviceSvc = new DeviceService();
  private streamSvc!: StreamService;
  private importSvc = new ImportService();
  private deviceTracker?: { dispose: () => void };
  private lastDevices: DeviceInfo[] = [];
  private pendingWaitToken = 0;
  private currentSelectedSerial: string = '';
  private knownDevices: Map<string, DeviceInfo> = new Map();
  private importActive = false;
  private pidMapSvc?: PidMapService;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('Android Logcat (Cursor)');
    this.debugEnabled = !!vscode.workspace.getConfiguration('cursorAndroidLogcat').get('debug');
    this.proc = new ProcessManager(
      context,
      (text) => this.post({ type: 'append', text }),
      (text) => this.post({ type: 'status', text }),
      () => !!this.view?.visible,
      (...p) => this.debugLog(...p),
      () => this.markSelectedDeviceOfflineOnExit()
    );
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
    webviewView.webview.options = { enableScripts: true, retainContextWhenHidden: true } as any;
    webviewView.webview.html = loadWebviewHtml(this.context);

    const cfgDisp = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cursorAndroidLogcat.debug')) {
        this.debugEnabled = !!vscode.workspace.getConfiguration('cursorAndroidLogcat').get('debug');
        this.debugLog('config changed: debug =', this.debugEnabled);
        this.post({ type: 'debug', enabled: this.debugEnabled });
      }
    });
    this.context.subscriptions.push(cfgDisp);

    // 初始化 StreamService
    this.streamSvc = new StreamService(this.context, (t) => this.post({ type: 'append', text: t }), (s) => this.post({ type: 'status', text: s }), () => !!this.view?.visible, (...p) => this.debugLog(...p), () => this.markSelectedDeviceOfflineOnExit());

    // 初始化 PID 映射服务
    this.pidMapSvc = new PidMapService((delta) => {
      this.post({ type: 'pidMap', map: delta });
    }, (...p) => this.debugLog(...p));

    // 启动设备跟踪
    if (!this.deviceTracker) {
      this.deviceTracker = this.deviceSvc.startTracking(async (devices) => {
        const fresh = devices || [];
        // 更新已知表
        this.lastDevices = fresh;
        const last = this.getLastConfig();
        this.post({ type: 'devices', devices: this.lastDevices, defaultSerial: last?.serial ?? '' });
        this.debugLog('trackDevices:update', this.lastDevices.length);

        // 若当前选择的设备恢复为在线且未在运行，并且不处于导入模式，则自动启动并拉取历史
        try {
          if (this.view?.visible && this.currentSelectedSerial && !this.importActive) {
            const me = this.lastDevices.find(d => d.serial === this.currentSelectedSerial);
            const status = (me?.status || '').toLowerCase();
            const isOnline = (!status || status === 'device');
            if (isOnline && !this.streamSvc.isRunning()) {
              this.post({ type: 'status', text: '设备已恢复在线，正在自动启动…' });
              this.startStreamForSerial(this.currentSelectedSerial);
              const text = await this.dumpHistory(this.currentSelectedSerial, 5000);
              this.post({ type: 'historyDump', text });
              this.post({ type: 'status', text: '历史日志已加载' });
            }
          }
        } catch {}
      });
    }

    webviewView.onDidChangeVisibility(async () => {
      this.debugLog('onDidChangeVisibility', { visible: webviewView.visible });
      if (webviewView.visible) {
        this.proc.onVisible();
        // 避免频繁刷新：先让前端根据其缓存自行恢复，再异步刷新设备
        this.post({ type: 'visible' });
        queueMicrotask(() => this.refreshDevicesAsync());
        // 重新开启 PID 映射刷新（切回面板后 PID 可能变化，如 surfaceflinger 重启）
        this.pidMapSvc?.start(1000);
        this.pidMapSvc?.refreshNow();
      } else {
        this.proc.onHidden();
        this.pidMapSvc?.stop();
      }
    });

    webviewView.onDidDispose(() => {
      this.debugLog('onDidDispose');
      this.stopProcess();
      try { this.deviceTracker?.dispose(); } catch {}
      this.deviceTracker = undefined;
    });

    webviewView.webview.onDidReceiveMessage(async (msg: any) => {
      if (msg?.type) this.debugLog('onDidReceiveMessage', msg.type);
      switch (msg.type) {
        case 'ready': {
          this.post({ type: 'debug', enabled: this.debugEnabled });
          // 报告解析到的 adb 路径，便于诊断 PATH 差异
          try { this.post({ type: 'status', text: 'ADB: ' + getResolvedAdbPath() }); } catch {}
          this.refreshDevicesAsync();
          // ADB 冷启动或权限弹窗场景：在首段时间窗内做指数退避重试，直到拿到设备
          this.ensureDevicesSoon();
          this.postLastConfigToWebview();
          this.autoStartIfPossible();
          // 若首次扫描为空，短暂退避后再重试一次，避免 adb 冷启动窗口导致的空列表
          setTimeout(() => {
            try {
              if (!this.lastDevices || this.lastDevices.length === 0) {
                this.debugLog('ready: devices empty, retry refresh');
                this.refreshDevicesAsync();
              }
            } catch {}
          }, 600);
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
          this.streamSvc.clearBuffers();
          this.post({ type: 'status', text: '已清空（仅UI与缓冲）' });
          this.debugLog('cleared buffers');
          break;
        }
        case 'refreshDevices': {
          this.debugLog('refreshDevices');
          this.refreshDevicesAsync();
          break;
        }
        case 'selectDevice': {
          const serial = String(msg.serial || '').trim();
          if (!serial) {
            this.post({ type: 'status', text: '请先选择设备' });
            break;
          }
          this.currentSelectedSerial = serial;
          const dev = this.lastDevices.find(d => d.serial === serial);
          const status = (dev?.status || '').toLowerCase();
          if (status === 'unauthorized') {
            this.post({ type: 'status', text: '设备未授权，请在手机上允许 USB 调试' });
            break;
          }
          if (!status || status === 'device') {
            this.startStreamForSerial(serial);
            this.pidMapSvc?.start(1000);
            break;
          }
          // offline 等状态：有限退避等待上线
          const token = ++this.pendingWaitToken;
          this.post({ type: 'status', text: '设备离线，等待设备上线…' });
          const attempts = [15000, 30000, 60000];
          (async () => {
            for (let i = 0; i < attempts.length; i++) {
              if (token !== this.pendingWaitToken) return; // 用户已切换设备
              if (!this.view?.visible) return; // 面板不可见时取消
              const ok = await adbWaitForDevice(serial, attempts[i]);
              if (token !== this.pendingWaitToken) return;
              if (!this.view?.visible) return;
              if (ok) {
                this.post({ type: 'status', text: '设备已上线，正在启动…' });
                this.startStreamForSerial(serial);
                this.pidMapSvc?.start(1000);
                // 加载一次历史
                this.post({ type: 'status', text: '正在加载历史日志...' });
                try {
                  const text = await this.dumpHistory(serial, 10000);
                  this.post({ type: 'historyDump', text });
                  this.post({ type: 'status', text: '历史日志已加载' });
                } catch {
                  this.post({ type: 'status', text: '加载历史日志失败' });
                }
                return;
              }
            }
            if (token === this.pendingWaitToken) {
              this.post({ type: 'status', text: '重连超时，请稍后重试或检查设备连接' });
            }
          })();
          break;
        }
        case 'start': {
          if (!this.streamSvc.isRunning()) {
            const m = msg as any;
            if (!m.serial) {
              this.post({ type: 'status', text: '请先选择设备' });
              return;
            }
            // 记录当前选中串口，便于退出时标记离线
            this.currentSelectedSerial = String(m.serial);
            this.debugLog('startProcess by user', { serial: m.serial, pkg: m.pkg, tag: m.tag, level: m.level, buffer: m.buffer, save: !!m.save });
            this.streamSvc.start({
              serial: m.serial,
              pkg: m.pkg || '',
              tag: m.tag || '*',
              level: m.level || 'D',
              buffer: m.buffer || 'main',
              save: !!m.save,
            });
            this.setLastConfig({
              serial: m.serial,
              pkg: m.pkg || '',
              tag: m.tag || '*',
              level: m.level || 'D',
              buffer: m.buffer || 'main',
              save: !!m.save,
            });
          } else if (this.streamSvc.isPaused()) {
            this.streamSvc.resume();
          } else {
            this.post({ type: 'status', text: '已在运行中' });
          }
          break;
        }
        case 'stop': {
          this.streamSvc.stop();
          break;
        }
        case 'pause': {
          this.streamSvc.pause();
          break;
        }
          case 'restart': {
            try {
              const serial = String((msg as any).serial || this.currentSelectedSerial || '').trim();
              if (!serial) {
                this.post({ type: 'status', text: '请先选择设备' });
                break;
              }
              this.post({ type: 'status', text: '正在重启 logcat…' });
              // 复用现有启动逻辑：停止并用最近配置重新启动
              this.startStreamForSerial(serial);
              // 可选：加载少量历史以对齐 Android Studio 行为
              try {
                const text = await this.dumpHistory(serial, 2000);
                this.post({ type: 'historyDump', text });
              } catch {}
              this.post({ type: 'status', text: '已重启' });
            } catch {}
            break;
          }
        case 'exportLogs': {
          const plainText: string = String(msg.text || '');
          const suggested: string = String(msg.suggested || 'AndroidLog.txt');
          try {
            this.post({ type: 'status', text: '正在准备导出...' });
            const defaultPath = path.join(os.homedir(), 'Desktop', suggested);
            const uri = await vscode.window.showSaveDialog({
              title: 'Export Logs to a File',
              defaultUri: vscode.Uri.file(defaultPath),
              filters: { Text: ['txt'], 'All Files': ['*'] },
              saveLabel: 'Save',
            });
            if (!uri) {
              this.post({ type: 'status', text: '已取消导出' });
              break;
            }
            await vscode.workspace.fs.writeFile(uri, Buffer.from(plainText, 'utf8'));
            this.post({ type: 'status', text: '已导出日志: ' + uri.fsPath });
          } catch (e) {
            this.post({ type: 'status', text: '导出失败' });
            this.debugLog('export error', String(e));
          }
          break;
        }
        case 'importLogs': {
          try {
            const uri = await vscode.window.showOpenDialog({
              title: 'Import Logs from a File',
              canSelectMany: false,
              filters: { Text: ['txt'] },
              openLabel: 'Open'
            });
            if (!uri || uri.length === 0) {
              this.post({ type: 'status', text: '已取消导入' });
              break;
            }
            const file = uri[0];
            const data = await vscode.workspace.fs.readFile(file);
            const text = Buffer.from(data).toString('utf8');
            // 进入导入模式：先停止实时抓取
            try { this.streamSvc.stop(); } catch {}
            const name = extractFileName(file.fsPath);
            // 通知前端切换导入模式（按钮置灰等）
            this.post({ type: 'importMode', name });
            // 下发导入内容（放在 importMode 之后，前端将清理缓冲避免残留）
            this.post({ type: 'importDump', text });
            this.importActive = true;
            this.post({ type: 'status', text: '已导入日志: ' + file.fsPath });
          } catch (e) {
            this.post({ type: 'status', text: '导入失败' });
            this.debugLog('import error', String(e));
          }
          break;
        }
        case 'pidMiss': {
          try { const pid = Number((msg as any).pid || 0); if (pid && this.pidMapSvc) { this.pidMapSvc.demand([pid]); } } catch {}
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
        // 同步更新缓存，便于后续重试逻辑判断
        this.lastDevices = devices || [];
        const last = this.getLastConfig();
        this.post({ type: 'devices', devices, defaultSerial: last?.serial ?? '' });
        this.debugLog('listDevices:found', devices?.length ?? 0);
      })
      .finally(() => {
        this.isRefreshingDevices = false;
        this.debugLog('listDevices:done');
      });
  }

  private ensureDevicesSoon(delays: number[] = [300, 800, 1500, 2500, 4000]) {
    const tryOnce = (idx: number) => {
      if (idx >= delays.length) return;
      setTimeout(() => {
        // 若已有设备则不再重试
        if (this.lastDevices && this.lastDevices.length > 0) return;
        this.debugLog('ensureDevicesSoon:retry', delays[idx]);
        this.listDevices()
          .then((devices) => {
            if (devices && devices.length > 0) {
              this.lastDevices = devices;
              const last = this.getLastConfig();
              this.post({ type: 'devices', devices, defaultSerial: last?.serial ?? '' });
              this.debugLog('ensureDevicesSoon:got', devices.length);
            } else {
              tryOnce(idx + 1);
            }
          })
          .catch(() => tryOnce(idx + 1));
      }, Math.max(0, delays[idx]));
    };
    tryOnce(0);
  }

  private getLastConfig(): { serial: string; pkg: string; tag: string; level: string; buffer: string; save: boolean } | null {
    return getLastConfig(this.context);
  }

  private setLastConfig(cfg: { serial: string; pkg: string; tag: string; level: string; buffer: string; save: boolean }) {
    setLastConfig(this.context, cfg as LastConfig);
  }

  private postLastConfigToWebview() {
    const last = this.getLastConfig();
    if (last) {
      this.post({ type: 'config', config: last });
      this.debugLog('post config', last);
    }
  }

  private async autoStartIfPossible() {
    if (this.hasAutoStarted || this.proc.isRunning()) return;
    this.debugLog('autoStartIfPossible:checking');
    const devices = await this.listDevices();
    if (!devices || devices.length === 0) {
      this.post({ type: 'status', text: '未检测到设备，自动启动跳过' });
      this.debugLog('autoStartIfPossible:no devices');
      return;
    }
    const last = this.getLastConfig();
    let targetSerial = last?.serial as string | undefined;
    if (!targetSerial || !devices.find(d => d.serial === targetSerial)) {
      targetSerial = devices[0].serial;
    }
    this.currentSelectedSerial = targetSerial!;
    this.debugLog('autoStartIfPossible:start', { serial: targetSerial });
    this.startStreamForSerial(targetSerial!);
    this.hasAutoStarted = true;
  }

  private post(message: any) {
    if (this.debugEnabled && message && message.type && message.type !== 'append') {
      this.debugLog('post -> webview', message.type);
    }
    this.view?.webview.postMessage(message);
  }

  // 进程与缓冲逻辑下沉到 ProcessManager

  private dumpHistory(serial: string, maxLines: number = 5000): Promise<string> {
    return this.streamSvc.dumpHistory(serial, maxLines);
  }

  private stopProcess() { this.streamSvc.stop(); }

  private listDevices(): Promise<DeviceInfo[]> {
    return adbListDevices();
  }

  private startStreamForSerial(serial: string) {
    this.currentSelectedSerial = serial;
    this.importActive = false;
    if (this.streamSvc.isRunning()) {
      this.streamSvc.stop();
    }
    const last = this.getLastConfig() || { serial: '', pkg: '', tag: '*', level: 'D', buffer: 'main', save: false };
    const startCfg = { serial, pkg: last.pkg, tag: last.tag, level: last.level, buffer: last.buffer, save: last.save };
    this.debugLog('startStreamForSerial', startCfg);
    this.streamSvc.start(startCfg);
    this.setLastConfig(startCfg);
  }

  private markSelectedDeviceOfflineOnExit() {
    try {
      if (!this.currentSelectedSerial) return;
      const info = this.knownDevices.get(this.currentSelectedSerial) || { serial: this.currentSelectedSerial } as any;
      this.knownDevices.set(this.currentSelectedSerial, { serial: this.currentSelectedSerial, model: info.model, status: 'offline' });
      // 组装一次列表并推送（不依赖 adb 事件），确保默认串口指向当前
      const list: DeviceInfo[] = [];
      for (const [serial, d] of this.knownDevices.entries()) list.push({ serial, model: d.model, status: d.status });
      const last = this.getLastConfig();
      this.post({ type: 'devices', devices: list, defaultSerial: this.currentSelectedSerial || last?.serial || '' });
      this.debugLog('markSelectedDeviceOfflineOnExit posted');
    } catch {}
  }

  private extractFileName(full: string): string {
    try {
      const base = full.replace(/\\/g,'/').split('/').pop() || full;
      return base;
    } catch { return full; }
  }
}


