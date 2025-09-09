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
  const htmlTmpl = fs.readFileSync(htmlPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  const js = fs.readFileSync(jsPath, 'utf8');
  return htmlTmpl
    .replace(/\{\{CSP\}\}/g, csp)
    .replace(/\{\{NONCE\}\}/g, nonce)
    .replace('/*INJECT_STYLE*/', css)
    .replace(/\{\{SCRIPT\}\}/g, js);
}


