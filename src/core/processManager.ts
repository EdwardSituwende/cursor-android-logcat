import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';

export type StartOptions = { serial: string; pkg: string; tag: string; level: string; buffer: string; save?: boolean; since?: string };

export class ProcessManager {
  private currentProc: ChildProcessWithoutNullStreams | null = null;
  private isRunningInternal = false;
  private isPausedInternal = false;
  private requestedPaused = false;
  private bufferedWhileHidden = "";
  private pausedBuffer = "";
  private pendingAppend = "";
  private appendFlushTimer: NodeJS.Timeout | null = null;
  private readonly APPEND_FLUSH_INTERVAL_MS = 33;
  private readonly APPEND_SIZE_THRESHOLD = 64 * 1024;
  private lastEmittedLine = ""; // 用于相邻去重
  private carryOverFragment = ""; // 上一批未以换行结束的残片

  private lastOpts: StartOptions | null = null;
  private lastPid: string = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onAppend: (text: string) => void,
    private readonly onStatus: (text: string) => void,
    private readonly isVisible: () => boolean,
    private readonly debugLog: (...parts: any[]) => void,
    private readonly onExit?: () => void
  ) {}

  isRunning(): boolean { return this.isRunningInternal; }
  isPaused(): boolean { return this.isPausedInternal; }

  onVisible() {
    if (this.bufferedWhileHidden.length > 0) {
      this.onAppend(this.bufferedWhileHidden);
      this.bufferedWhileHidden = "";
    }
  }

  onHidden() {
    if (this.pendingAppend.length > 0) {
      this.bufferedWhileHidden += this.pendingAppend;
      this.pendingAppend = "";
    }
    this.cancelAppendFlushTimer();
  }

  start(opts: StartOptions) {
    if (this.isRunningInternal) return;
    const scriptPath = this.getScriptPath();
    const args: string[] = [];
    if (opts.serial) args.push('-s', opts.serial);
    if (opts.pkg) args.push('-p', opts.pkg);
    if (opts.tag && opts.tag.trim() !== '') args.push('-t', opts.tag.trim());
    if (opts.level) args.push('-l', opts.level);
    if (opts.buffer) args.push('-b', opts.buffer);
    args.push('--no-color');
    if (opts.save) args.push('-f');
    if (opts.since && opts.since.trim()) args.push('--since', opts.since.trim());

    this.lastOpts = opts;
    this.lastPid = '';

    const cwdDir = this.context.extensionUri.fsPath;
    const proc = spawn(scriptPath, args, { env: { ...process.env, DISABLE_SCRIPT: '1' }, cwd: cwdDir });
    this.currentProc = proc;
    this.isRunningInternal = true;

    // 插入类似 logcat 的缓冲区起始标记
    const buffersToMark = this.computeBuffersToMark(opts.buffer);
    for (const b of buffersToMark) {
      this.onAppend('--------- beginning of ' + b + '\n');
    }

    // 若指定了包名，尝试解析 PID 并插入“PROCESS STARTED”标记
    if (opts.pkg && opts.pkg.trim()) {
      this.resolvePidAsync(opts.serial, opts.pkg).then((pid) => {
        this.lastPid = pid || '';
        const line = '---------------------------- PROCESS STARTED (' + (pid || 'unknown') + ') for package ' + opts.pkg + ' ----------------------------\n';
        this.onAppend(line);
      }).catch(() => {
        const line = '---------------------------- PROCESS STARTED (unknown) for package ' + opts.pkg + ' ----------------------------\n';
        this.onAppend(line);
      });
    }

    this.onStatus(`启动: ${scriptPath} ${args.join(' ')}`);
    this.debugLog('spawn', { scriptPath, args });
    if (this.requestedPaused) {
      this.isPausedInternal = true;
      this.onStatus('按用户指令：启动后立即暂停');
      this.debugLog('requestedPaused honored at start');
    }

    proc.stdout.on('data', (buf) => this.handleChunk(buf.toString()));
    proc.stderr.on('data', (buf) => this.handleChunk(buf.toString()));
    proc.on('close', (code, signal) => {
      this.onStatus(`已退出 (code=${code}, signal=${signal ?? ''})`);
      // 结束标记（若有包名）
      if (this.lastOpts && this.lastOpts.pkg) {
        const endLine = '---------------------------- PROCESS ENDED (' + (this.lastPid || 'unknown') + ') for package ' + this.lastOpts.pkg + ' ----------------------------\n';
        this.onAppend(endLine);
      }
      this.debugLog('process closed', { code, signal });
      this.isRunningInternal = false;
      this.currentProc = null;
      this.bufferedWhileHidden = "";
      this.isPausedInternal = false;
      this.pausedBuffer = '';
      try { this.onExit && this.onExit(); } catch {}
    });
    proc.on('error', (err) => {
      this.onStatus(`进程错误: ${String(err)}`);
      this.debugLog('process error', String(err));
      try { this.onExit && this.onExit(); } catch {}
    });
  }

  pause() {
    this.requestedPaused = true;
    if (this.isRunningInternal && !this.isPausedInternal) {
      this.isPausedInternal = true;
      this.onStatus('已暂停');
      this.debugLog('paused');
    } else if (!this.isRunningInternal) {
      this.onStatus('未在运行（已记录暂停指令，启动后生效）');
    }
  }

  resume() {
    if (!this.isPausedInternal) return;
    if (this.pausedBuffer.length > 0) {
      this.onAppend(this.pausedBuffer);
      this.pausedBuffer = '';
    }
    this.isPausedInternal = false;
    this.requestedPaused = false;
    this.onStatus('已恢复');
    this.debugLog('resumed');
  }

  stop() {
    if (this.currentProc) {
      try { this.currentProc.kill('SIGINT'); } catch {}
    }
    this.currentProc = null;
    this.isRunningInternal = false;
    this.isPausedInternal = false;
    this.pausedBuffer = '';
    this.onStatus('已停止');
  }

  clearBuffers() {
    this.bufferedWhileHidden = "";
    this.pausedBuffer = "";
    this.pendingAppend = "";
    this.cancelAppendFlushTimer();
  }

  private handleChunk(chunk: string) {
    if (this.isPausedInternal) {
      this.pausedBuffer += chunk;
    } else if (this.isVisible()) {
      this.queueAppend(chunk);
    } else {
      this.bufferedWhileHidden += chunk;
    }
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
    const textToEmit = this.dedupeAdjacentLines(this.pendingAppend);
    if (this.isVisible()) {
      if (textToEmit) this.onAppend(textToEmit);
    } else {
      this.bufferedWhileHidden += this.pendingAppend;
    }
    this.pendingAppend = "";
    this.cancelAppendFlushTimer();
  }

  private dedupeAdjacentLines(chunk: string): string {
    try {
      if (!chunk) return "";
      let text = chunk;
      // 若存在上批未结束的行残片，则与本批首行拼接后再参与去重
      if (this.carryOverFragment) {
        text = this.carryOverFragment + text;
        this.carryOverFragment = "";
      }
      const endsWithNl = /\n$/.test(text);
      const lines = text.split(/\n/);
      // 若不以换行结尾，最后一项是残片，暂不用于“完整行”去重
      const lastIndex = lines.length - 1;
      const out: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const isTailFragment = (i === lastIndex) && !endsWithNl;
        if (isTailFragment) {
          // 暂存残片等待下一批补全
          this.carryOverFragment = lines[i];
          break;
        }
        const line = lines[i];
        if (line === this.lastEmittedLine) {
          continue; // 丢弃与上一条完全相同的相邻行
        }
        out.push(line);
        this.lastEmittedLine = line;
      }
      // 重新拼接并恢复末尾换行
      const joined = out.join('\n');
      return joined + (joined && endsWithNl ? '\n' : (endsWithNl ? '\n' : ''));
    } catch {
      return chunk; // 兜底：异常时不做去重
    }
  }

  private cancelAppendFlushTimer() {
    if (this.appendFlushTimer) {
      clearTimeout(this.appendFlushTimer);
      this.appendFlushTimer = null;
    }
  }

  private getScriptPath(): string {
    const cfg = vscode.workspace.getConfiguration('cursorAndroidLogcat');
    const configured = cfg.get<string>('scriptPath');
    if (configured && configured.trim()) return configured;
    return path.join(this.context.extensionUri.fsPath, 'scripts', 'logcat_android', 'cli_logcat.sh');
  }

  private computeBuffersToMark(buffer: string): string[] {
    const b = String(buffer || '').toLowerCase();
    if (!b || b === 'main') return ['main'];
    if (b === 'all') return ['main', 'system', 'events', 'radio'];
    return [b];
  }

  private resolvePidAsync(serial: string, pkg: string): Promise<string> {
    return new Promise((resolve) => {
      const args = ['-s', serial, 'shell', 'pidof', pkg];
      const proc = spawn('adb', args);
      const chunks: Buffer[] = [];
      proc.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
      proc.stderr.on('data', (d) => chunks.push(Buffer.from(d)));
      proc.on('close', () => {
        const out = Buffer.concat(chunks).toString().trim();
        resolve(out || '');
      });
      proc.on('error', () => resolve(''));
    });
  }
}


