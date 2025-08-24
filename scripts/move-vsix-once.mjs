#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(projectRoot, 'package.json');
const vsixOutDir = path.join(projectRoot, 'vsix_directory');

function candidateVsixNames(pkg) {
  // vsce may name file as either:
  // 1) <publisher>.<name>-<version>.vsix
  // 2) <name>-<version>.vsix
  const publisher = pkg.publisher || 'publisher';
  const name = (pkg.name || 'extension').replace(/^@/, '').replace(/[\s]/g, '-');
  const version = pkg.version || '1.0.0';
  return [
    `${publisher}.${name}-${version}.vsix`,
    `${name}-${version}.vsix`,
  ];
}

async function waitForFileOnce(filePath, timeoutMs = 300000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (fs.existsSync(filePath)) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve(false);
      }
    }, 500);
    const timer = setTimeout(() => {
      clearInterval(interval);
      resolve(false);
    }, timeoutMs + 1000);
  });
}

async function main() {
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    const candidates = candidateVsixNames(pkg).map((n) => ({ name: n, full: path.join(projectRoot, n) }));
    const toDir = vsixOutDir;
    fs.mkdirSync(toDir, { recursive: true });

    // Try all candidates
    let foundPath = '';
    let foundName = '';
    for (const c of candidates) {
      const ok = await waitForFileOnce(c.full, 300000);
      if (ok) {
        foundPath = c.full;
        foundName = c.name;
        break;
      }
    }

    // Fallback: find most recent .vsix matching current version anywhere in project root
    if (!foundPath) {
      const files = fs.readdirSync(projectRoot)
        .filter((f) => f.endsWith('.vsix') && f.includes(pkg.version))
        .map((f) => ({ f, stat: fs.statSync(path.join(projectRoot, f)) }))
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
      if (files.length > 0) {
        foundName = files[0].f;
        foundPath = path.join(projectRoot, foundName);
      }
    }

    // Final fallback: most recent .vsix even if version does not match
    if (!foundPath) {
      const files = fs.readdirSync(projectRoot)
        .filter((f) => f.endsWith('.vsix'))
        .map((f) => ({ f, stat: fs.statSync(path.join(projectRoot, f)) }))
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
      if (files.length > 0) {
        foundName = files[0].f;
        foundPath = path.join(projectRoot, foundName);
      }
    }

    if (!foundPath || !fs.existsSync(foundPath)) {
      // Nothing to move
      process.exit(0);
    }

    // Build destination path
    let toPath = path.join(toDir, foundName);
    if (fs.existsSync(toPath)) {
      const parsed = path.parse(toPath);
      toPath = path.join(parsed.dir, `${parsed.name}-${Date.now()}${parsed.ext}`);
    }
    fs.renameSync(foundPath, toPath);
    console.log(`[move-vsix] Moved ${foundName} to ${toPath}`);
  } catch (err) {
    // Do not fail packaging due to mover errors
    console.warn('[move-vsix] Warn:', err && err.message ? err.message : String(err));
  }
}

main();


