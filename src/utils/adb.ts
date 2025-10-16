import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { CONFIG_KEYS, REGEX, TIMING, DEFAULTS } from './constants';

export type DeviceInfo = { serial: string; model?: string; status?: string };

/**
 * 获取用户配置的 ADB 路径
 */
function getConfiguredAdbPath(): string | undefined {
  try {
    const v = vscode.workspace.getConfiguration().get<string>(CONFIG_KEYS.ADB_PATH);
    if (v && v.trim()) return v.trim();
  } catch {}
  return undefined;
}

/**
 * 检查文件是否可执行
 */
function isExecutable(p: string): boolean {
  try { 
    fs.accessSync(p, fs.constants.X_OK); 
    return true; 
  } catch { 
    return false; 
  }
}

/**
 * 在 PATH 中查找命令
 */
function which(cmd: string): string | undefined {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.BAT;.CMD').split(';') : [''];
  const paths = (process.env.PATH || '').split(path.delimiter);
  for (const dir of paths) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      if (fs.existsSync(full)) return full;
    }
  }
  return undefined;
}

/**
 * 查找 ADB 可执行文件路径
 * 优先级：1) 用户配置 2) PATH 3) Android SDK 4) 常见路径
 */
function findAdb(): string {
  // 1) 配置项
  const cfg = getConfiguredAdbPath();
  if (cfg && fs.existsSync(cfg)) return cfg;
  // 2) PATH
  const viaPath = which('adb');
  if (viaPath) return viaPath;
  // 3) ANDROID_HOME/ANDROID_SDK_ROOT/platform-tools
  const candidates: string[] = [];
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (sdk) candidates.push(path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'));
  // 4) 常见路径
  const home = os.homedir();
  candidates.push(path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'));
  candidates.push('/usr/local/bin/adb');
  candidates.push('/opt/homebrew/bin/adb');
  for (const pth of candidates) {
    if (fs.existsSync(pth)) return pth;
  }
  // 回退：依然返回 'adb' 交由系统解析
  return 'adb';
}

function spawnAdb(args: string[]) {
  const adb = findAdb();
  return spawn(adb, args);
}

export function getResolvedAdbPath(): string {
  return findAdb();
}

/**
 * 导出历史日志
 * @param serial 设备序列号
 * @param maxLines 最大行数
 */
export function dumpHistory(serial: string, maxLines: number = DEFAULTS.MAX_HISTORY_LINES): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-s', serial, 'logcat', '-d', '-b', 'all', '-v', 'time', '-t', String(maxLines)];
    const proc = spawnAdb(args);
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
    proc.stderr.on('data', (d) => chunks.push(Buffer.from(d)));
    proc.on('close', () => {
      try {
        resolve(Buffer.concat(chunks).toString());
      } catch (error) {
        reject(new Error('Failed to concatenate log buffers'));
      }
    });
    proc.on('error', (error) => reject(new Error(`Failed to spawn adb: ${error.message}`)));
  });
}

/**
 * 列出连接的设备
 */
export function listDevices(): Promise<DeviceInfo[]> {
  return new Promise((resolve) => {
    const proc = spawnAdb(['devices', '-l']);
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
    proc.stderr.on('data', (d) => chunks.push(Buffer.from(d)));
    proc.on('close', () => {
      try {
        const out = Buffer.concat(chunks).toString();
        resolve(parseDevicesOutput(out));
      } catch {
        resolve([]);
      }
    });
    proc.on('error', () => resolve([]));
  });
}

/**
 * 解析 adb devices 输出
 */
function parseDevicesOutput(out: string): DeviceInfo[] {
  const lines = out.split(/\r?\n/);
  const devices: DeviceInfo[] = [];
  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line) continue;
    // 跳过标题和守护进程提示
    if (REGEX.DEVICES_HEADER.test(line)) continue;
    if (REGEX.DAEMON_MESSAGE.test(line)) continue;
    // 仅接受形如: "<serial> <status> ..." 且 status 在已知集合内
    const mHead = line.match(/^(\S+)\s+(\S+)(?:\s|$)/);
    if (!mHead) continue;
    const status = (mHead[2] || '').toLowerCase();
    if (!REGEX.DEVICE_STATUS.test(status)) continue;
    const serial = mHead[1];
    let model: string | undefined;
    const m = line.match(REGEX.DEVICE_MODEL);
    if (m) model = m[1];
    devices.push({ serial, model, status });
  }
  return devices;
}

/**
 * 跟踪设备连接状态变化
 * @param onList 设备列表更新回调
 */
export function trackDevices(onList: (devices: DeviceInfo[]) => void): { dispose: () => void } {
  let disposed = false;
  // track-devices 不支持 -l；收到事件后再调用一次 devices -l 补充详细信息
  const proc: ChildProcessWithoutNullStreams = spawnAdb(['track-devices']);
  let timer: NodeJS.Timeout | null = null;
  const scheduleRefresh = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      listDevices().then((list) => {
        try { onList(list); } catch {}
      }).catch(() => {
        try { onList([]); } catch {}
      });
    }, TIMING.DEVICE_REFRESH_DELAY_MS);
  };
  proc.stdout.on('data', () => scheduleRefresh());
  proc.stderr.on('data', () => scheduleRefresh());
  proc.on('close', () => scheduleRefresh());
  // 启动后先发一次现状
  scheduleRefresh();
  proc.on('error', () => {});
  return {
    dispose: () => {
      disposed = true;
      try { proc.kill('SIGINT'); } catch {}
    }
  };
}

/**
 * 等待设备上线
 * @param serial 设备序列号
 * @param timeoutMs 超时时间（毫秒）
 * @returns 设备是否成功上线
 */
export function waitForDevice(serial: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const args = ['-s', serial, 'wait-for-device'];
    const p = spawnAdb(args);
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try { p.kill('SIGINT'); } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    p.on('close', () => { clearTimeout(timer); finish(true); });
    p.on('error', () => { clearTimeout(timer); finish(false); });
  });
}


