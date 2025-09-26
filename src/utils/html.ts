import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

export function loadWebviewHtml(context: vscode.ExtensionContext): string {
  const nonce = Math.random().toString(36).slice(2);
  const csp = `default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const base = context.extensionUri.fsPath;
  const htmlPath = path.join(base, 'media', 'view.html');
  const cssPath = path.join(base, 'media', 'view.css');
  const jsPath = path.join(base, 'media', 'view.js');
  const jsDir = path.join(base, 'media', 'js');
  const htmlTmpl = fs.readFileSync(htmlPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  let js = fs.readFileSync(jsPath, 'utf8');
  // 若存在模块化 JS 目录，则按文件名顺序追加到 view.js 之后
  try {
    if (fs.existsSync(jsDir)) {
      const extraFiles = fs.readdirSync(jsDir)
        .filter((f) => f.toLowerCase().endsWith('.js'))
        .sort((a, b) => a.localeCompare(b));
      for (const f of extraFiles) {
        const p = path.join(jsDir, f);
        const content = fs.readFileSync(p, 'utf8');
        js += `\n\n/* ---- injected: ${f} ---- */\n` + content;
      }
    }
  } catch {}
  return htmlTmpl
    .replace(/\{\{CSP\}\}/g, csp)
    .replace(/\{\{NONCE\}\}/g, nonce)
    .replace('/*INJECT_STYLE*/', css)
    .replace(/\{\{SCRIPT\}\}/g, js);
}


