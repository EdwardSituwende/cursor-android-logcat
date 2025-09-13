import { Disposable } from 'vscode';
import { DeviceInfo, listDevices, trackDevices } from '../utils/adb';

export type DevicesUpdateHandler = (devices: DeviceInfo[]) => void;

export class DeviceService {
  private knownDevices: Map<string, DeviceInfo> = new Map();
  private tracker?: { dispose: () => void };

  async list(): Promise<DeviceInfo[]> {
    const devs = await listDevices();
    return devs;
  }

  startTracking(onUpdate: DevicesUpdateHandler): Disposable {
    if (this.tracker) {
      try { this.tracker.dispose(); } catch {}
      this.tracker = undefined;
    }
    this.tracker = trackDevices((devices) => {
      const fresh = devices || [];
      for (const d of fresh) {
        const prev = this.knownDevices.get(d.serial);
        const merged: DeviceInfo = { serial: d.serial, model: d.model || prev?.model, status: d.status };
        this.knownDevices.set(d.serial, merged);
      }
      const freshSet = new Set(fresh.map(d => d.serial));
      const mergedList: DeviceInfo[] = [];
      for (const d of fresh) mergedList.push(d);
      for (const [serial, info] of this.knownDevices.entries()) {
        if (!freshSet.has(serial)) {
          mergedList.push({ serial, model: info.model, status: 'offline' });
        }
      }
      try { onUpdate(mergedList); } catch {}
    });
    return { dispose: () => { try { this.tracker?.dispose(); } catch {}; this.tracker = undefined; } };
  }

  markOffline(serial: string): void {
    if (!serial) return;
    const info = this.knownDevices.get(serial) || { serial } as any;
    this.knownDevices.set(serial, { serial, model: info.model, status: 'offline' });
  }

  snapshot(): DeviceInfo[] {
    const list: DeviceInfo[] = [];
    for (const [serial, info] of this.knownDevices.entries()) {
      list.push({ serial, model: info.model, status: info.status });
    }
    return list;
  }
}


