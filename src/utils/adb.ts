import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';

export type DeviceInfo = { serial: string; model?: string; status?: string };

export function dumpHistory(serial: string, maxLines: number = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-s', serial, 'logcat', '-d', '-b', 'all', '-v', 'time', '-t', String(maxLines)];
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

export function listDevices(): Promise<DeviceInfo[]> {
  return new Promise((resolve) => {
    const proc = spawn('adb', ['devices', '-l']);
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

function parseDevicesOutput(out: string): DeviceInfo[] {
  const lines = out.split(/\r?\n/);
  // 去掉可能存在的标题行
  const body = lines[0] && /List of devices attached/i.test(lines[0]) ? lines.slice(1) : lines;
  const devices: DeviceInfo[] = [];
  for (const raw of body) {
    const line = String(raw || '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const serial = parts[0];
    const status = parts[1]; // device | offline | unauthorized | unknown
    let model: string | undefined;
    const m = line.match(/model:(\S+)/);
    if (m) model = m[1];
    // 接受所有状态的设备，交由上层决定是否可用
    devices.push({ serial, model, status });
  }
  return devices;
}

export function trackDevices(onList: (devices: DeviceInfo[]) => void): { dispose: () => void } {
  let disposed = false;
  // track-devices 不支持 -l；收到事件后再调用一次 devices -l 补充详细信息
  const proc: ChildProcessWithoutNullStreams = spawn('adb', ['track-devices']);
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
    }, 150);
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

export function waitForDevice(serial: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const args = ['-s', serial, 'wait-for-device'];
    const p = spawn('adb', args);
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


