import * as vscode from 'vscode';
import { ProcessManager, StartOptions } from '../core/processManager';
import { dumpHistory as adbDumpHistory } from '../utils/adb';

export class StreamService {
  private proc: ProcessManager;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onAppend: (text: string) => void,
    private readonly onStatus: (text: string) => void,
    private readonly isVisible: () => boolean,
    private readonly debugLog: (...parts: any[]) => void,
    private readonly onExit: () => void,
  ) {
    this.proc = new ProcessManager(context, onAppend, onStatus, isVisible, debugLog, onExit);
  }

  isRunning(): boolean { return this.proc.isRunning(); }
  isPaused(): boolean { return this.proc.isPaused(); }

  start(opts: StartOptions) { this.proc.start(opts); }
  stop() { this.proc.stop(); }
  pause() { this.proc.pause(); }
  resume() { this.proc.resume(); }
  clearBuffers() { this.proc.clearBuffers(); }

  dumpHistory(serial: string, maxLines: number = 5000): Promise<string> { return adbDumpHistory(serial, maxLines); }
}


