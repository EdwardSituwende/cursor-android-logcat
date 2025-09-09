import * as vscode from 'vscode';

export interface LastConfig {
  serial: string;
  pkg: string;
  tag: string;
  level: string;
  buffer: string;
  save: boolean;
}

const LAST_KEY = 'lastConfig.v1';

export function getLastConfig(context: vscode.ExtensionContext): LastConfig | null {
  const raw = context.globalState.get<any>(LAST_KEY);
  if (!raw) return null;
  const { serial = '', pkg = '', tag = '*', level = 'D', buffer = 'main', save = false } = raw as any;
  return { serial, pkg, tag, level, buffer, save };
}

export function setLastConfig(context: vscode.ExtensionContext, cfg: LastConfig): void {
  void context.globalState.update(LAST_KEY, cfg);
}


