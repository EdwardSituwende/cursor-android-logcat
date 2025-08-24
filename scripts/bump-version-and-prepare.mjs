#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(projectRoot, 'package.json');
const vsixOutDir = path.join(projectRoot, 'vsix_directory');

function bumpPatch(version) {
  const parts = String(version).split('.');
  if (parts.length !== 3) return '1.0.0';
  const [major, minor, patch] = parts.map((n) => Number(n) || 0);
  return `${major}.${minor}.${patch + 1}`;
}

function main() {
  const raw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);

  const nextVersion = bumpPatch(pkg.version || '1.0.0');
  pkg.version = nextVersion;

  // Ensure out dir exists
  fs.mkdirSync(vsixOutDir, { recursive: true });

  // Add vsce package dir setting via npm_config if not already set by env
  // We will not mutate user .npmrc; instead advise running with env var or use postpackage copy fallback.

  // Persist bumped version
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  // Create a small marker file noting the target output dir for later scripts (optional)
  const hintPath = path.join(vsixOutDir, '.keep');
  if (!fs.existsSync(hintPath)) {
    fs.writeFileSync(hintPath, '');
  }
}

main();


