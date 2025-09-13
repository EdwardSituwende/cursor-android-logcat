import * as vscode from 'vscode';
import { spawn } from 'node:child_process';

export class PidMapService {
  private map = new Map<number, string>();
  private timer: NodeJS.Timeout | null = null;
  private lastDemandAt = 0;
  private pendingDemand = new Set<number>();
  private readonly DEMAND_THROTTLE_MS = 500;

  constructor(private readonly onDelta: (delta: Record<string, string>) => void,
              private readonly debugLog: (...parts: any[]) => void) {}

  start(intervalMs: number = 1000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.refresh(), Math.max(500, intervalMs));
    this.refresh();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  get(pid: number): string | undefined { return this.map.get(pid); }

  demand(pids: number[]) {
    for (const p of pids) if (p) this.pendingDemand.add(p);
    const now = Date.now();
    if (now - this.lastDemandAt >= this.DEMAND_THROTTLE_MS) {
      this.lastDemandAt = now;
      this.refresh();
    }
  }

  refreshNow() { this.refresh(); }

  private refresh() {
    this.runPs(['shell','ps','-A','-o','PID,NAME'], (out1) => {
      if (this.merge(out1)) return;
      this.runPs(['shell','ps','-A'], (out2) => {
        if (this.mergeGeneric(out2)) return;
        this.runPs(['shell','ps'], (out3) => { this.mergeGeneric(out3); });
      });
    });
  }

  private runPs(args: string[], cb: (out: string) => void) {
    try {
      const proc = spawn('adb', args);
      const chunks: Buffer[] = [];
      proc.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
      proc.stderr.on('data', (d) => chunks.push(Buffer.from(d)));
      proc.on('close', () => cb(Buffer.concat(chunks).toString()));
      proc.on('error', (e) => { this.debugLog('pidmap:spawn error', String(e)); cb(''); });
    } catch(e) { this.debugLog('pidmap:spawn exception', String(e)); cb(''); }
  }

  private merge(out: string): boolean {
    const lines = out.split(/\r?\n/);
    const delta: Record<string, string> = {};
    let hit = false;
    for (const line of lines) {
      const m = line.trim().match(/^(\d+)\s+([^\s]+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      let name = m[2];
      // 规范化：若包含路径，取 basename
      if (name.indexOf('/') !== -1) name = name.substring(name.lastIndexOf('/') + 1);
      if (!pid || !name) continue;
      if (this.map.get(pid) !== name) {
        this.map.set(pid, name);
        delta[String(pid)] = name;
        hit = true;
      }
    }
    if (Object.keys(delta).length > 0) {
      try { this.onDelta(delta); } catch {}
    }
    return hit;
  }

  private mergeGeneric(out: string): boolean {
    const lines = out.split(/\r?\n/);
    const delta: Record<string, string> = {}; 
    let hit = false;
    for (const line of lines) {
      const t = line.trim();
      if (!t || /^PID\b/i.test(t)) continue;
      const parts = t.split(/\s+/);
      let pid = 0; let name = '';
      for (let i = 0; i < parts.length; i++) {
        const v = parts[i];
        if (/^\d+$/.test(v)) { pid = Number(v); }
      }
      name = parts[parts.length - 1] || '';
      if (name.indexOf('/') !== -1) name = name.substring(name.lastIndexOf('/') + 1);
      if (!pid || !name) continue;
      if (this.map.get(pid) !== name) {
        this.map.set(pid, name);
        delta[String(pid)] = name;
        hit = true;
      }
    }
    if (Object.keys(delta).length > 0) {
      try { this.onDelta(delta); } catch {}
    }
    return hit;
  }
}


