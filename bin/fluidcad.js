#!/usr/bin/env node

import { fork } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { writeFileSync, existsSync } from 'fs';
import { createFileWatcher } from './watcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { values, positionals } = parseArgs({
  options: {
    port: { type: 'string', short: 'p', default: '3100' },
    workspace: { type: 'string', short: 'w', default: process.cwd() },
  },
  allowPositionals: true,
});

if (positionals[0] === 'init') {
  const cwd = process.cwd();

  const initPath = resolve(cwd, 'init.js');
  if (existsSync(initPath)) {
    console.error('init.js already exists in this directory.');
    process.exit(1);
  }

  writeFileSync(initPath, `import { init } from 'fluidcad'\n\nexport default init()\n`);

  const jsconfigPath = resolve(cwd, 'jsconfig.json');
  if (!existsSync(jsconfigPath)) {
    writeFileSync(jsconfigPath, JSON.stringify({
      compilerOptions: {
        checkJs: true,
        module: 'node20',
      },
    }, null, 2) + '\n');
  }

  console.log('FluidCAD initialized.');
  process.exit(0);
}

const serverEntry = resolve(__dirname, '..', 'server', 'dist', 'index.js');

const server = fork(serverEntry, [], {
  env: {
    ...process.env,
    FLUIDCAD_SERVER_PORT: values.port,
    FLUIDCAD_WORKSPACE_PATH: resolve(values.workspace),
  },
  stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
});

server.stdout.on('data', (data) => {
  process.stdout.write(data);
});

server.stderr.on('data', (data) => {
  process.stderr.write(data);
});

const workspacePath = resolve(values.workspace);
let watcher;

server.on('message', (msg) => {
  if (msg.type === 'ready') {
    console.log(`FluidCAD server ready at ${msg.url}`);
  }
  if (msg.type === 'init-complete') {
    if (msg.success) {
      console.log('FluidCAD initialized successfully.');
      watcher = createFileWatcher(workspacePath, server);
    } else {
      console.error(`FluidCAD initialization failed: ${msg.error}`);
      process.exit(1);
    }
  }
});

server.on('exit', (code) => {
  process.exit(code || 0);
});

process.on('SIGINT', () => {
  if (watcher) { watcher.close(); }
  server.kill('SIGINT');
});

process.on('SIGTERM', () => {
  if (watcher) { watcher.close(); }
  server.kill('SIGTERM');
});
