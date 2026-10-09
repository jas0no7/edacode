import { chmodSync, readFileSync } from 'node:fs';
const entry = new URL('../dist/cli.js', import.meta.url);
if (!readFileSync(entry, 'utf8').startsWith('#!/usr/bin/env node\n')) throw new Error('CLI shebang missing');
chmodSync(entry, 0o755);
