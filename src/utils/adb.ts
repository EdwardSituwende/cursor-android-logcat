import { spawn } from 'node:child_process';

export type DeviceInfo = { serial: string; model?: string };

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


