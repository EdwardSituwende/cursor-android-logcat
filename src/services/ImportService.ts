import * as vscode from 'vscode';
import { extractFileName } from '../utils/path';

export class ImportService {
  private active = false;
  isActive(): boolean { return this.active; }

  async enter(): Promise<{ name: string; text: string } | null> {
    const uri = await vscode.window.showOpenDialog({
      title: 'Import Logs from a File',
      canSelectMany: false,
      filters: { Text: ['txt'] },
      openLabel: 'Open'
    });
    if (!uri || uri.length === 0) return null;
    const file = uri[0];
    const data = await vscode.workspace.fs.readFile(file);
    const text = Buffer.from(data).toString('utf8');
    const name = extractFileName(file.fsPath);
    this.active = true;
    return { name, text };
  }

  exit(): void { this.active = false; }

  // legacy kept for backward compatibility if needed
}


